// Usage Tracker Server
// Build: g++ -std=c++17 -pthread -O2 -o usage-tracker-server server.cpp
// Run:   ./usage-tracker-server

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#include <pwd.h>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#include <algorithm>
#include <cctype>
#include <ctime>

static constexpr int PORT = 7878;

struct AppEntry {
    long long total = 0;
    std::map<std::string, long long> children;
};

struct Store {
    std::map<std::string, AppEntry> apps;
    std::map<std::string, std::map<std::string, AppEntry>> dailyApps;
    std::string currentWebDomain;
    std::string currentWebApp;
    std::mutex mtx;
};

static Store g_store;
static std::atomic<bool> g_running{true};
static std::string g_save_path;
static std::string g_daily_path;
static std::string g_dashboard_dir;
static std::string g_lastScheduledResetDate;

static void sendResponse(int fd,
                         const std::string &status,
                         const std::string &contentType,
                         const std::string &body,
                         bool cors);
static void send404(int fd);
static void saveToDisk();

static std::string jsonEsc(const std::string &s) {
    std::string o;
    for (char c : s) {
        if (c == '"') o += "\\\"";
        else if (c == '\\') o += "\\\\";
        else o += c;
    }
    return o;
}

static std::string mapToJson(const std::map<std::string, long long> &m) {
    std::ostringstream o;
    o << "{";
    bool first = true;
    for (const auto &[k, v] : m) {
        if (!first) o << ",";
        o << "\"" << jsonEsc(k) << "\":" << v;
        first = false;
    }
    o << "}";
    return o.str();
}

static std::string appsToJson(const std::map<std::string, AppEntry> &apps) {
    std::ostringstream o;
    o << "{";
    bool firstApp = true;
    for (const auto &[appName, entry] : apps) {
        if (!firstApp) o << ",";
        o << "\"" << jsonEsc(appName) << "\":{";
        o << "\"total\":" << entry.total << ",";
        o << "\"children\":" << mapToJson(entry.children);
        o << "}";
        firstApp = false;
    }
    o << "}";
    return o.str();
}

static std::string currentLocalDate() {
    const std::time_t now = std::time(nullptr);
    std::tm tmNow{};
    localtime_r(&now, &tmNow);

    char buf[11];
    if (std::strftime(buf, sizeof(buf), "%Y-%m-%d", &tmNow) == 0)
        return "1970-01-01";
    return buf;
}

static std::string statsPayloadFromApps(const std::map<std::string, AppEntry> &apps) {
    std::map<std::string, long long> appLegacy;
    std::map<std::string, long long> webLegacy;

    for (const auto &[appName, entry] : apps) {
        appLegacy[appName] = entry.total;
        for (const auto &[domain, sec] : entry.children)
            webLegacy[domain] += sec;
    }

    return "\"apps\":" + appsToJson(apps) +
           ",\"app\":" + mapToJson(appLegacy) +
           ",\"web\":" + mapToJson(webLegacy);
}

static std::string buildStats() {
    std::lock_guard<std::mutex> lk(g_store.mtx);
    return "{" + statsPayloadFromApps(g_store.apps) + "}";
}

static std::string buildDailyStats(const std::string &requestedDate) {
    const std::string date = (requestedDate.empty() || requestedDate == "today")
        ? currentLocalDate()
        : requestedDate;

    const std::map<std::string, AppEntry> emptyApps;

    std::lock_guard<std::mutex> lk(g_store.mtx);
    const auto it = g_store.dailyApps.find(date);
    const auto &apps = (it != g_store.dailyApps.end()) ? it->second : emptyApps;

    return "{\"date\":\"" + jsonEsc(date) + "\"," + statsPayloadFromApps(apps) + "}";
}

static std::string buildDailyDates() {
    std::lock_guard<std::mutex> lk(g_store.mtx);
    std::ostringstream o;
    o << "{\"dates\":[";

    bool first = true;
    for (auto it = g_store.dailyApps.rbegin(); it != g_store.dailyApps.rend(); ++it) {
        if (!first)
            o << ",";
        o << "\"" << jsonEsc(it->first) << "\"";
        first = false;
    }

    o << "]}";
    return o.str();
}

static std::string buildDailyStoreJson() {
    std::lock_guard<std::mutex> lk(g_store.mtx);
    std::ostringstream o;
    o << "{\"days\":{";

    bool firstDay = true;
    for (const auto &[date, apps] : g_store.dailyApps) {
        if (!firstDay)
            o << ",";
        o << "\"" << jsonEsc(date) << "\":{";
        o << "\"apps\":" << appsToJson(apps);
        o << "}";
        firstDay = false;
    }

    o << "}}";
    return o.str();
}

static std::string buildHistory() {
    std::lock_guard<std::mutex> lk(g_store.mtx);

    std::map<std::string, long long> merged;
    for (const auto &[appName, entry] : g_store.apps) {
        (void)appName;
        for (const auto &[domain, sec] : entry.children)
            merged[domain] += sec;
    }

    std::vector<std::pair<std::string, long long>> rows(merged.begin(), merged.end());
    std::sort(rows.begin(), rows.end(), [](const auto &a, const auto &b) {
        return a.second > b.second;
    });

    std::ostringstream o;
    o << "{\"currentDomain\":\"" << jsonEsc(g_store.currentWebDomain) << "\",";
    o << "\"currentApp\":\"" << jsonEsc(g_store.currentWebApp) << "\",";
    o << "\"tabs\":[";
    bool first = true;
    for (const auto &[domain, sec] : rows) {
        if (!first) o << ",";
        o << "{\"domain\":\"" << jsonEsc(domain) << "\",\"duration\":" << sec << "}";
        first = false;
    }
    o << "]}";
    return o.str();
}

static bool endsWith(const std::string &value, const std::string &suffix) {
    if (suffix.size() > value.size())
        return false;
    return value.compare(value.size() - suffix.size(), suffix.size(), suffix) == 0;
}

static std::string dirnameOf(const std::string &path) {
    const auto pos = path.find_last_of('/');
    if (pos == std::string::npos)
        return ".";
    if (pos == 0)
        return "/";
    return path.substr(0, pos);
}

static std::string resolveDashboardDir() {
    char exePathBuf[4096];
    const ssize_t n = readlink("/proc/self/exe", exePathBuf, sizeof(exePathBuf) - 1);
    if (n <= 0)
        return "dashboard";

    exePathBuf[n] = '\0';
    const std::string exePath(exePathBuf);
    const std::string serverDir = dirnameOf(exePath);
    const std::string extensionDir = dirnameOf(serverDir);
    return extensionDir + "/dashboard";
}

static bool isSafeDashboardAsset(const std::string &assetPath) {
    if (assetPath.empty() || assetPath.front() == '/')
        return false;

    if (assetPath.find("..") != std::string::npos)
        return false;

    for (char c : assetPath) {
        const unsigned char uc = static_cast<unsigned char>(c);
        if (std::isalnum(uc))
            continue;
        if (c == '/' || c == '.' || c == '_' || c == '-')
            continue;
        return false;
    }

    return true;
}

static std::string contentTypeForPath(const std::string &path) {
    if (endsWith(path, ".html")) return "text/html; charset=utf-8";
    if (endsWith(path, ".js")) return "application/javascript; charset=utf-8";
    if (endsWith(path, ".css")) return "text/css; charset=utf-8";
    if (endsWith(path, ".json")) return "application/json; charset=utf-8";
    if (endsWith(path, ".svg")) return "image/svg+xml";
    if (endsWith(path, ".png")) return "image/png";
    if (endsWith(path, ".jpg") || endsWith(path, ".jpeg")) return "image/jpeg";
    return "text/plain; charset=utf-8";
}

static bool readFileText(const std::string &path, std::string &out) {
    std::ifstream f(path, std::ios::binary);
    if (!f)
        return false;

    std::ostringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

static bool serveDashboardAsset(int fd, const std::string &requestPath) {
    std::string assetPath;
    if (requestPath == "/dashboard" || requestPath == "/dashboard/") {
        assetPath = "index.html";
    } else if (requestPath.rfind("/dashboard/", 0) == 0) {
        assetPath = requestPath.substr(std::string("/dashboard/").size());
    } else {
        return false;
    }

    if (assetPath.empty())
        assetPath = "index.html";

    if (!isSafeDashboardAsset(assetPath)) {
        send404(fd);
        return true;
    }

    const std::string filePath = g_dashboard_dir + "/" + assetPath;
    std::string body;
    if (!readFileText(filePath, body)) {
        send404(fd);
        return true;
    }

    sendResponse(fd, "200 OK", contentTypeForPath(filePath), body, true);
    return true;
}

static std::string jStr(const std::string &body, const std::string &key) {
    auto pos = body.find("\"" + key + "\"");
    if (pos == std::string::npos) return {};
    pos = body.find(":", pos);
    if (pos == std::string::npos) return {};
    while (++pos < body.size() && isspace((unsigned char)body[pos])) {}
    if (pos >= body.size() || body[pos] != '"') return {};
    ++pos;
    std::string v;
    while (pos < body.size() && body[pos] != '"') {
        if (body[pos] == '\\') ++pos;
        if (pos < body.size()) v += body[pos++];
    }
    return v;
}

static long long jNum(const std::string &body, const std::string &key) {
    auto pos = body.find("\"" + key + "\"");
    if (pos == std::string::npos) return 0;
    pos = body.find(":", pos);
    if (pos == std::string::npos) return 0;
    while (++pos < body.size() && isspace((unsigned char)body[pos])) {}
    std::string n;
    while (pos < body.size() && (isdigit((unsigned char)body[pos]) || body[pos] == '-'))
        n += body[pos++];
    return n.empty() ? 0LL : std::stoll(n);
}

static void parseFlatMapSection(const std::string &json,
                                const std::string &key,
                                std::map<std::string, long long> &dst) {
    auto search = "\"" + key + "\":{";
    auto pos = json.find(search);
    if (pos == std::string::npos) return;

    pos += search.size();
    auto end = json.find("}", pos);
    if (end == std::string::npos) return;

    std::string sec = json.substr(pos, end - pos);
    size_t p = 0;
    while (p < sec.size()) {
        while (p < sec.size() && sec[p] != '"') ++p;
        if (p >= sec.size()) break;
        ++p;

        std::string k;
        while (p < sec.size() && sec[p] != '"') {
            if (sec[p] == '\\') ++p;
            if (p < sec.size()) k += sec[p++];
        }
        if (p < sec.size()) ++p;

        while (p < sec.size() && sec[p] != ':') ++p;
        if (p < sec.size()) ++p;

        while (p < sec.size() && isspace((unsigned char)sec[p])) ++p;

        std::string num;
        while (p < sec.size() && (isdigit((unsigned char)sec[p]) || sec[p] == '-'))
            num += sec[p++];

        if (!k.empty() && !num.empty())
            dst[k] = std::stoll(num);

        while (p < sec.size() && sec[p] != ',') ++p;
        if (p < sec.size() && sec[p] == ',') ++p;
    }
}

static bool parseQuoted(const std::string &s, size_t &p, std::string &out) {
    if (p >= s.size() || s[p] != '"') return false;
    ++p;
    out.clear();
    while (p < s.size() && s[p] != '"') {
        if (s[p] == '\\') ++p;
        if (p < s.size()) out += s[p++];
    }
    if (p >= s.size() || s[p] != '"') return false;
    ++p;
    return true;
}

static bool parseChildrenMap(const std::string &obj, std::map<std::string, long long> &children) {
    auto pos = obj.find("\"children\":{");
    if (pos == std::string::npos) return false;
    pos += std::string("\"children\":{").size();

    while (pos < obj.size()) {
        while (pos < obj.size() && (isspace((unsigned char)obj[pos]) || obj[pos] == ',')) ++pos;
        if (pos >= obj.size() || obj[pos] == '}') break;

        std::string key;
        if (!parseQuoted(obj, pos, key)) break;

        while (pos < obj.size() && (isspace((unsigned char)obj[pos]) || obj[pos] == ':')) ++pos;

        std::string num;
        while (pos < obj.size() && (isdigit((unsigned char)obj[pos]) || obj[pos] == '-'))
            num += obj[pos++];

        if (!key.empty() && !num.empty())
            children[key] = std::stoll(num);

        while (pos < obj.size() && obj[pos] != ',' && obj[pos] != '}') ++pos;
        if (pos < obj.size() && obj[pos] == ',') ++pos;
    }

    return true;
}

static bool extractBalancedObject(const std::string &text, size_t openPos, size_t &closePos) {
    if (openPos >= text.size() || text[openPos] != '{')
        return false;

    int depth = 0;
    for (size_t i = openPos; i < text.size(); ++i) {
        if (text[i] == '{') {
            depth++;
        } else if (text[i] == '}') {
            depth--;
            if (depth == 0) {
                closePos = i;
                return true;
            }
        }
    }

    return false;
}

static bool parseAppsSectionFromJson(const std::string &json, std::map<std::string, AppEntry> &parsedApps) {
    auto appsPos = json.find("\"apps\":{");
    if (appsPos == std::string::npos)
        return false;

    size_t p = appsPos + std::string("\"apps\":{").size();
    while (p < json.size()) {
        while (p < json.size() && (isspace((unsigned char)json[p]) || json[p] == ','))
            ++p;
        if (p >= json.size() || json[p] == '}')
            break;

        std::string appName;
        if (!parseQuoted(json, p, appName))
            break;

        while (p < json.size() && (isspace((unsigned char)json[p]) || json[p] == ':'))
            ++p;
        if (p >= json.size() || json[p] != '{')
            break;

        size_t closePos = std::string::npos;
        if (!extractBalancedObject(json, p, closePos))
            break;

        const std::string obj = json.substr(p, closePos - p + 1);
        p = closePos + 1;

        AppEntry entry;
        entry.total = jNum(obj, "total");
        parseChildrenMap(obj, entry.children);

        long long childSum = 0;
        for (const auto &[k, v] : entry.children) {
            (void)k;
            childSum += v;
        }
        if (entry.total < childSum)
            entry.total = childSum;

        if (!appName.empty())
            parsedApps[appName] = entry;
    }

    return !parsedApps.empty();
}

static void loadFromDisk() {
    std::ifstream f(g_save_path);
    if (!f) return;

    std::string json((std::istreambuf_iterator<char>(f)), {});

    std::map<std::string, AppEntry> parsedApps;
    if (parseAppsSectionFromJson(json, parsedApps)) {
        std::lock_guard<std::mutex> lk(g_store.mtx);
        g_store.apps = std::move(parsedApps);
        std::cout << "[server] Loaded data from " << g_save_path << "\n";
        return;
    }

    std::map<std::string, long long> appMap;
    std::map<std::string, long long> webMap;
    parseFlatMapSection(json, "app", appMap);
    parseFlatMapSection(json, "web", webMap);

    std::lock_guard<std::mutex> lk(g_store.mtx);
    for (const auto &[name, sec] : appMap)
        g_store.apps[name].total = sec;

    const std::string fallbackBrowser = "Google Chrome";
    for (const auto &[domain, sec] : webMap) {
        g_store.apps[fallbackBrowser].children[domain] += sec;
        g_store.apps[fallbackBrowser].total += sec;
    }

    std::cout << "[server] Loaded legacy data from " << g_save_path << "\n";
}

static void loadDailyFromDisk() {
    std::ifstream f(g_daily_path);
    if (!f)
        return;

    std::string json((std::istreambuf_iterator<char>(f)), {});
    auto daysPos = json.find("\"days\":{");
    if (daysPos == std::string::npos)
        return;

    std::map<std::string, std::map<std::string, AppEntry>> parsedDaily;
    size_t p = daysPos + std::string("\"days\":{").size();

    while (p < json.size()) {
        while (p < json.size() && (isspace((unsigned char)json[p]) || json[p] == ','))
            ++p;
        if (p >= json.size() || json[p] == '}')
            break;

        std::string dateKey;
        if (!parseQuoted(json, p, dateKey))
            break;

        while (p < json.size() && (isspace((unsigned char)json[p]) || json[p] == ':'))
            ++p;
        if (p >= json.size() || json[p] != '{')
            break;

        size_t dayClosePos = std::string::npos;
        if (!extractBalancedObject(json, p, dayClosePos))
            break;

        const std::string dayObj = json.substr(p, dayClosePos - p + 1);
        p = dayClosePos + 1;

        std::map<std::string, AppEntry> dayApps;
        if (!parseAppsSectionFromJson(dayObj, dayApps))
            continue;

        if (!dateKey.empty())
            parsedDaily[dateKey] = std::move(dayApps);
    }

    if (parsedDaily.empty())
        return;

    std::lock_guard<std::mutex> lk(g_store.mtx);
    g_store.dailyApps = std::move(parsedDaily);
    std::cout << "[server] Loaded daily data from " << g_daily_path << "\n";
}

static void hydrateLifetimeFromDailyIfNeeded() {
    std::lock_guard<std::mutex> lk(g_store.mtx);
    if (!g_store.apps.empty() || g_store.dailyApps.empty())
        return;

    for (const auto &[date, dayApps] : g_store.dailyApps) {
        (void)date;
        for (const auto &[appName, entry] : dayApps) {
            auto &dest = g_store.apps[appName];
            dest.total += entry.total;
            for (const auto &[domain, sec] : entry.children)
                dest.children[domain] += sec;
        }
    }
}

static void rebuildLifetimeFromDailyLocked() {
    g_store.apps.clear();
    for (const auto &[date, dayApps] : g_store.dailyApps) {
        (void)date;
        for (const auto &[appName, entry] : dayApps) {
            auto &dest = g_store.apps[appName];
            dest.total += entry.total;
            for (const auto &[domain, sec] : entry.children)
                dest.children[domain] += sec;
        }
    }
}

static void resetTodayDataNow() {
    const std::string today = currentLocalDate();

    {
        std::lock_guard<std::mutex> lk(g_store.mtx);
        g_store.dailyApps.erase(today);
        g_store.apps.clear();
        g_store.currentWebDomain.clear();
        g_store.currentWebApp.clear();
    }

    saveToDisk();
}

static void maybeResetLiveStatsAt2359() {
    const std::time_t now = std::time(nullptr);
    std::tm tmNow{};
    localtime_r(&now, &tmNow);

    if (tmNow.tm_hour != 23 || tmNow.tm_min != 59)
        return;

    const std::string dateKey = currentLocalDate();
    if (g_lastScheduledResetDate == dateKey)
        return;

    {
        std::lock_guard<std::mutex> lk(g_store.mtx);
        g_store.apps.clear();
        g_store.currentWebDomain.clear();
        g_store.currentWebApp.clear();
    }

    g_lastScheduledResetDate = dateKey;
    saveToDisk();
    std::cout << "[server] Scheduled 23:59 reset completed for " << dateKey << "\n";
}

static void saveToDisk() {
    std::ofstream f(g_save_path);
    if (f)
        f << buildStats();

    std::ofstream d(g_daily_path);
    if (d)
        d << buildDailyStoreJson();
}

static void sendResponse(int fd,
                         const std::string &status,
                         const std::string &contentType,
                         const std::string &body,
                         bool cors = true) {
    std::ostringstream r;
    r << "HTTP/1.1 " << status << "\r\n"
      << "Content-Type: " << contentType << "\r\n";

    if (cors) {
        r << "Access-Control-Allow-Origin: *\r\n"
          << "Access-Control-Allow-Methods: POST, GET, OPTIONS\r\n"
          << "Access-Control-Allow-Headers: Content-Type\r\n";
    }

    r << "Connection: close\r\n"
      << "Content-Length: " << body.size() << "\r\n\r\n"
      << body;

    std::string s = r.str();
    send(fd, s.c_str(), s.size(), 0);
}

static void send404(int fd) {
    sendResponse(fd, "404 Not Found", "application/json", "{\"error\":\"not found\"}");
}

static std::string queryValue(const std::string &query, const std::string &key) {
    size_t start = 0;
    while (start <= query.size()) {
        size_t end = query.find('&', start);
        if (end == std::string::npos)
            end = query.size();

        const std::string part = query.substr(start, end - start);
        const size_t eq = part.find('=');
        const std::string k = eq == std::string::npos ? part : part.substr(0, eq);
        const std::string v = eq == std::string::npos ? "" : part.substr(eq + 1);

        if (k == key)
            return v;

        start = end + 1;
    }

    return {};
}

static bool isValidDateKey(const std::string &value) {
    if (value == "today")
        return true;
    if (value.size() != 10)
        return false;

    for (size_t i = 0; i < value.size(); ++i) {
        if (i == 4 || i == 7) {
            if (value[i] != '-')
                return false;
            continue;
        }

        if (!std::isdigit((unsigned char)value[i]))
            return false;
    }

    return true;
}

static void handleActiveWebPayload(const std::string &body) {
    std::string domain = jStr(body, "domain");
    if (domain.empty())
        domain = jStr(body, "name");

    std::string app = jStr(body, "app");
    if (app.empty())
        app = jStr(body, "parent");

    std::lock_guard<std::mutex> lk(g_store.mtx);
    g_store.currentWebDomain = domain;
    g_store.currentWebApp = app;
}

static void handleTrackPayload(const std::string &body) {
    const auto type = jStr(body, "type");
    const auto name = jStr(body, "name");
    const auto duration = jNum(body, "duration");

    if (name.empty() || duration <= 0)
        return;

    const std::string dateKey = currentLocalDate();
    std::lock_guard<std::mutex> lk(g_store.mtx);

    if (type == "app") {
        g_store.apps[name].total += duration;
        g_store.dailyApps[dateKey][name].total += duration;
        return;
    }

    if (type == "web") {
        std::string parent = jStr(body, "app");
        if (parent.empty())
            parent = jStr(body, "parent");
        if (parent.empty())
            parent = "Google Chrome";

        auto &entry = g_store.apps[parent];
        entry.total += duration;
        entry.children[name] += duration;

        g_store.currentWebDomain = name;
        g_store.currentWebApp = parent;

        auto &dailyEntry = g_store.dailyApps[dateKey][parent];
        dailyEntry.total += duration;
        dailyEntry.children[name] += duration;
    }
}

static void handleClient(int fd) {
    char buf[4096];
    std::string raw;
    while (true) {
        int n = recv(fd, buf, sizeof(buf) - 1, 0);
        if (n <= 0) break;
        buf[n] = 0;
        raw += buf;
        if (raw.find("\r\n\r\n") != std::string::npos) break;
        if (raw.size() > 10240) break;
    }

    auto sp1 = raw.find(' ');
    auto sp2 = raw.find(' ', sp1 + 1);
    std::string method = sp1 != std::string::npos ? raw.substr(0, sp1) : "";
    std::string path = (sp1 != std::string::npos && sp2 != std::string::npos)
        ? raw.substr(sp1 + 1, sp2 - sp1 - 1)
        : "";

    std::string query;
    const auto queryPos = path.find('?');
    if (queryPos != std::string::npos) {
        query = path.substr(queryPos + 1);
        path = path.substr(0, queryPos);
    }

    if (method == "OPTIONS") {
        sendResponse(fd, "200 OK", "application/json", "{}", true);
        close(fd);
        return;
    }

    auto hdr_end = raw.find("\r\n\r\n");
    std::string body = hdr_end != std::string::npos ? raw.substr(hdr_end + 4) : "";

    auto cl_pos = raw.find("Content-Length:");
    if (cl_pos == std::string::npos) cl_pos = raw.find("content-length:");

    int cl = 0;
    if (cl_pos != std::string::npos) {
        cl_pos += 15;
        while (cl_pos < raw.size() && isspace((unsigned char)raw[cl_pos])) ++cl_pos;
        std::string cls;
        while (cl_pos < raw.size() && isdigit((unsigned char)raw[cl_pos])) cls += raw[cl_pos++];
        if (!cls.empty()) cl = std::stoi(cls);
    }

    int remaining = cl - (int)body.size();
    while (remaining > 0) {
        int n = recv(fd, buf, std::min(remaining, (int)sizeof(buf) - 1), 0);
        if (n <= 0) break;
        buf[n] = 0;
        body += buf;
        remaining -= n;
    }

    if (path == "/track" && method == "POST") {
        handleTrackPayload(body);
        sendResponse(fd, "200 OK", "application/json", "{\"ok\":true}", true);
    } else if (path == "/reset-today" && method == "POST") {
        resetTodayDataNow();
        sendResponse(fd, "200 OK", "application/json", "{\"ok\":true,\"reset\":\"today\"}", true);
    } else if (path == "/active-web" && method == "POST") {
        handleActiveWebPayload(body);
        sendResponse(fd, "200 OK", "application/json", "{\"ok\":true}", true);
    } else if (path == "/stats" && method == "GET") {
        sendResponse(fd, "200 OK", "application/json", buildStats(), true);
    } else if (path == "/daily" && method == "GET") {
        std::string date = queryValue(query, "date");
        if (date.empty())
            date = "today";
        if (!isValidDateKey(date)) {
            sendResponse(fd, "400 Bad Request", "application/json", "{\"error\":\"invalid date\"}", true);
            close(fd);
            return;
        }
        sendResponse(fd, "200 OK", "application/json", buildDailyStats(date), true);
    } else if (path == "/daily-dates" && method == "GET") {
        sendResponse(fd, "200 OK", "application/json", buildDailyDates(), true);
    } else if (path == "/history" && method == "GET") {
        sendResponse(fd, "200 OK", "application/json", buildHistory(), true);
    } else if (method == "GET" && serveDashboardAsset(fd, path)) {
        // served by dashboard static handler
    } else {
        send404(fd);
    }

    close(fd);
}

static void saveLoop() {
    while (g_running) {
        for (int i = 0; i < 60 && g_running; ++i)
            std::this_thread::sleep_for(std::chrono::seconds(1));

        if (g_running)
            saveToDisk();
    }
}

static void onSignal(int) {
    g_running = false;
}

int main() {
    const char *home = getenv("HOME");
    if (!home) {
        struct passwd *pw = getpwuid(getuid());
        home = pw ? pw->pw_dir : "/tmp";
    }

    std::string data_dir = std::string(home) + "/.local/share/usage-tracker";
    mkdir(data_dir.c_str(), 0755);
    g_save_path = data_dir + "/stats.json";
    g_daily_path = data_dir + "/daily-stats.json";
    g_dashboard_dir = resolveDashboardDir();

    loadFromDisk();
    loadDailyFromDisk();
    hydrateLifetimeFromDailyIfNeeded();

    signal(SIGINT, onSignal);
    signal(SIGTERM, onSignal);

    std::thread(saveLoop).detach();

    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0)
        return 1;

    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    addr.sin_port = htons(PORT);

    if (bind(server_fd, (sockaddr *)&addr, sizeof(addr)) < 0) {
        std::cerr << "bind() failed on port " << PORT << "\n";
        return 1;
    }

    listen(server_fd, 16);

    std::cout << "[server] Listening on http://127.0.0.1:" << PORT << "\n";
    std::cout << "[server] Stats       : GET http://127.0.0.1:" << PORT << "/stats\n";
    std::cout << "[server] Daily       : GET http://127.0.0.1:" << PORT << "/daily?date=today\n";
    std::cout << "[server] Reset Today : POST http://127.0.0.1:" << PORT << "/reset-today\n";
    std::cout << "[server] Daily Dates : GET http://127.0.0.1:" << PORT << "/daily-dates\n";
    std::cout << "[server] History     : GET http://127.0.0.1:" << PORT << "/history\n";
    std::cout << "[server] Dashboard   : GET http://127.0.0.1:" << PORT << "/dashboard\n";
    std::cout << "[server] DashboardDir: " << g_dashboard_dir << "\n";
    std::cout << "[server] Data        : " << g_save_path << "\n";
    std::cout << "[server] Daily Data  : " << g_daily_path << "\n";

    while (g_running) {
        maybeResetLiveStatsAt2359();

        fd_set fds;
        FD_ZERO(&fds);
        FD_SET(server_fd, &fds);
        timeval tv{1, 0};
        if (select(server_fd + 1, &fds, nullptr, nullptr, &tv) <= 0)
            continue;

        int client_fd = accept(server_fd, nullptr, nullptr);
        if (client_fd < 0)
            continue;

        std::thread(handleClient, client_fd).detach();
    }

    close(server_fd);
    saveToDisk();
    std::cout << "[server] Stopped. Final data saved.\n";
    return 0;
}
