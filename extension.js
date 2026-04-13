import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

class TrackerSettings {
    constructor() {
        this._defaults = {
            indicatorPosition: 'left',
            childLimit: 5,
            autoStartServer: true,
        };
        this._configDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'app-usage-tracker']);
        this._settingsPath = GLib.build_filenamev([this._configDir, 'settings.json']);
    }

    _read() {
        try {
            if (!GLib.file_test(this._settingsPath, GLib.FileTest.EXISTS))
                return {...this._defaults};

            const [ok, contents] = GLib.file_get_contents(this._settingsPath);
            if (!ok)
                return {...this._defaults};

            const text = typeof contents === 'string' ? contents : new TextDecoder().decode(contents);
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object')
                return {...this._defaults};
            return {...this._defaults, ...parsed};
        } catch (e) {
            return {...this._defaults};
        }
    }

    _write(data) {
        try {
            GLib.mkdir_with_parents(this._configDir, 0o755);
            GLib.file_set_contents(this._settingsPath, JSON.stringify(data));
        } catch (e) {
            log('[AppUsageTracker] Failed to write settings: ' + e);
        }
    }

    getIndicatorPosition() {
        const value = this._read().indicatorPosition;
        if (value === 'left' || value === 'center' || value === 'right')
            return value;
        return this._defaults.indicatorPosition;
    }

    getChildLimit() {
        const value = Number(this._read().childLimit);
        if (!Number.isFinite(value))
            return this._defaults.childLimit;
        return Math.max(1, Math.min(20, Math.floor(value)));
    }

    getAutoStartServer() {
        return Boolean(this._read().autoStartServer);
    }
}

class AppUsageTracker {
    constructor(uuid, extensionPath, settings) {
        this._uuid = uuid;
        this._extensionPath = extensionPath;
        this._settings = settings;

        this._windowTracker = Shell.WindowTracker.get_default();
        this._usageMap = new Map();
        this._serverApps = new Map();
        this._webTotals = new Map();

        this._lastApp = null;
        this._lastAppGicon = null;
        this._lastTime = 0;
        this._currentDomain = null;
        this._lastWebTotals = new Map();
        this._siteIconCache = new Map();
        this._siteIconInFlight = new Set();
        this._appIconCache = new Map();

        this._focusSignalId = 0;
        this._tickId = 0;
        this._syncId = 0;

        this._browserApps = new Set([
            'google chrome',
            'chrome',
            'chromium',
            'chromium browser',
            'brave',
            'brave browser',
            'brave web browser',
        ]);

        try {
            this._soupSession = new Soup.Session();
        } catch (e) {
            this._soupSession = null;
            log('[AppUsageTracker] Soup initialization failed: ' + e);
        }

        this._serverUrl = 'http://127.0.0.1:7878/track';
        this._statsUrl = 'http://127.0.0.1:7878/stats';
        this._historyUrl = 'http://127.0.0.1:7878/history';
        this._dashboardUrl = 'http://127.0.0.1:7878/dashboard';
        this._serverBinaryPath = GLib.build_filenamev([this._extensionPath, 'server', 'usage-tracker-server']);
        this._iconDir = GLib.build_filenamev([this._extensionPath, 'icon']);
        this._siteIconDir = GLib.build_filenamev([this._iconDir, 'sites']);
        this._appIconDir = GLib.build_filenamev([this._iconDir, 'apps']);
        this._whiteSurAppIconDirs = [
            GLib.build_filenamev([GLib.get_home_dir(), '.icons', 'WhiteSur-dark', 'apps', 'symbolic']),
            GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'icons', 'WhiteSur-dark', 'apps', 'symbolic']),
            GLib.build_filenamev(['/usr', 'share', 'icons', 'WhiteSur-dark', 'apps', 'symbolic']),
        ];

        try {
            GLib.mkdir_with_parents(this._siteIconDir, 0o755);
            GLib.mkdir_with_parents(this._appIconDir, 0o755);
        } catch (e) {
            log('[AppUsageTracker] Failed to create icon dir: ' + e);
        }

        this._onUpdate = null;
    }

    setUpdateCallback(callback) {
        this._onUpdate = callback;
    }

    _ensureServerReadyOnEnable() {
        if (!this._settings.getAutoStartServer())
            return;

        this._getJson(this._statsUrl, stats => {
            if (stats)
                return;

            if (!this._startServerProcess())
                return;

            // Give the server a brief moment to bind, then pull initial data.
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._syncServerData();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    enable() {
        this._ensureServerReadyOnEnable();

        this._focusSignalId = global.display.connect('notify::focus-window', () => {
            this._handleFocusChange();
        });

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._incrementCurrent();
            this._emitUpdate();
            return GLib.SOURCE_CONTINUE;
        });

        this._syncId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._syncServerData();
            return GLib.SOURCE_CONTINUE;
        });

        this._handleFocusChange();
        this._syncServerData();
    }

    disable() {
        if (this._tickId) {
            GLib.Source.remove(this._tickId);
            this._tickId = 0;
        }
        if (this._syncId) {
            GLib.Source.remove(this._syncId);
            this._syncId = 0;
        }
        if (this._focusSignalId) {
            global.display.disconnect(this._focusSignalId);
            this._focusSignalId = 0;
        }

        this._incrementCurrent();

        if (this._soupSession)
            this._soupSession.abort();

        this._lastApp = null;
        this._lastAppGicon = null;
        this._lastTime = 0;
        this._currentDomain = null;
        this._lastWebTotals.clear();
        this._siteIconCache.clear();
        this._siteIconInFlight.clear();
        this._appIconCache.clear();
        this._serverApps.clear();
        this._webTotals.clear();
    }

    _emitUpdate() {
        if (this._onUpdate)
            this._onUpdate();
    }

    _isBrowserApp(appName) {
        if (!appName)
            return false;
        return this._browserApps.has(String(appName).toLowerCase());
    }

    _getJson(url, callback) {
        if (!this._soupSession) {
            callback(null);
            return;
        }

        try {
            const msg = Soup.Message.new('GET', url);
            if (!msg) {
                callback(null);
                return;
            }

            this._soupSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    const text = new TextDecoder().decode(bytes.get_data());
                    callback(JSON.parse(text));
                } catch (e) {
                    callback(null);
                }
            });
        } catch (e) {
            callback(null);
        }
    }

    _postTrack(payload) {
        if (!this._soupSession)
            return;

        try {
            const msg = Soup.Message.new('POST', this._serverUrl);
            if (!msg)
                return;
            const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(payload)));
            msg.set_request_body_from_bytes('application/json', bytes);
            this._soupSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    session.send_and_read_finish(res);
                } catch (e) {
                    // ignore connectivity failures
                }
            });
        } catch (e) {
            // ignore connectivity failures
        }
    }

    _incrementCurrent() {
        if (!this._lastApp)
            return;

        const now = Math.floor(GLib.get_monotonic_time() / 1000000);
        const diff = now - this._lastTime;

        if (diff > 0) {
            const current = this._usageMap.get(this._lastApp) || 0;
            this._usageMap.set(this._lastApp, current + diff);
            this._postTrack({type: 'app', name: this._lastApp, duration: diff});
        }

        this._lastTime = now;
    }

    _domainToFileName(domain) {
        return String(domain || '')
            .toLowerCase()
            .replace(/[^a-z0-9.-]/g, '_');
    }

    _siteIconPath(domain) {
        const fileName = this._domainToFileName(domain);
        if (!fileName)
            return null;
        return GLib.build_filenamev([this._siteIconDir, `${fileName}.png`]);
    }

    _ensureSiteIcon(domain) {
        if (!domain || !this._soupSession)
            return;

        const path = this._siteIconPath(domain);
        if (!path)
            return;

        if (this._siteIconCache.has(domain))
            return;

        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            this._siteIconCache.set(domain, path);
            return;
        }

        if (this._siteIconInFlight.has(domain))
            return;
        this._siteIconInFlight.add(domain);

        const url = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`;

        try {
            const msg = Soup.Message.new('GET', url);
            if (!msg) {
                this._siteIconInFlight.delete(domain);
                return;
            }

            this._soupSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    const data = bytes.get_data();
                    if (data && data.length > 0) {
                        GLib.file_set_contents(path, data);
                        this._siteIconCache.set(domain, path);
                        if (domain === this._currentDomain)
                            this._emitUpdate();
                    }
                } catch (e) {
                    // ignore icon download failures
                } finally {
                    this._siteIconInFlight.delete(domain);
                }
            });
        } catch (e) {
            this._siteIconInFlight.delete(domain);
        }
    }

    _appIconCacheKey(appName) {
        return String(appName || '').toLowerCase();
    }

    _sanitizeIconBase(baseName) {
        return String(baseName || '').replace(/[^a-zA-Z0-9._-]/g, '');
    }

    _themedIconNames(gicon) {
        if (!gicon)
            return [];

        try {
            if (gicon instanceof Gio.ThemedIcon)
                return gicon.get_names() || [];
        } catch (e) {
            // ignore themed icon extraction errors
        }

        return [];
    }

    _appIconNameCandidates(appName, gicon) {
        const candidates = new Set();
        const lower = String(appName || '').toLowerCase();

        for (const name of this._themedIconNames(gicon))
            candidates.add(name);

        if (lower) {
            const dashed = lower.replace(/\s+/g, '-');
            const underscored = lower.replace(/\s+/g, '_');
            const compact = lower.replace(/\s+/g, '');
            candidates.add(dashed);
            candidates.add(underscored);
            candidates.add(compact);
        }

        if (lower === 'visual studio code') {
            candidates.add('code');
            candidates.add('visual-studio-code');
        } else if (lower === 'google chrome') {
            candidates.add('google-chrome');
            candidates.add('chrome');
        } else if (lower === 'brave web browser' || lower === 'brave browser') {
            candidates.add('brave-browser');
            candidates.add('brave');
        } else if (lower === 'files') {
            candidates.add('org.gnome.Nautilus');
            candidates.add('org.gnome.Nautilus-symbolic');
            candidates.add('system-file-manager');
        } else if (lower === 'terminal') {
            candidates.add('org.gnome.Terminal');
            candidates.add('utilities-terminal');
        }

        return Array.from(candidates).map(name => this._sanitizeIconBase(name)).filter(Boolean);
    }

    _findOrCopyStaticAppIconByBase(baseName) {
        const base = this._sanitizeIconBase(baseName);
        if (!base)
            return null;

        const names = [base];
        if (!base.endsWith('-symbolic'))
            names.push(`${base}-symbolic`);

        for (const name of names) {
            for (const ext of ['svg', 'png']) {
                const localPath = GLib.build_filenamev([this._appIconDir, `${name}.${ext}`]);
                if (GLib.file_test(localPath, GLib.FileTest.EXISTS))
                    return localPath;
            }
        }

        for (const srcDir of this._whiteSurAppIconDirs) {
            if (!GLib.file_test(srcDir, GLib.FileTest.IS_DIR))
                continue;

            for (const name of names) {
                for (const ext of ['svg', 'png']) {
                    const srcPath = GLib.build_filenamev([srcDir, `${name}.${ext}`]);
                    if (!GLib.file_test(srcPath, GLib.FileTest.EXISTS))
                        continue;

                    const destPath = GLib.build_filenamev([this._appIconDir, `${name}.${ext}`]);
                    try {
                        Gio.File.new_for_path(srcPath).copy(
                            Gio.File.new_for_path(destPath),
                            Gio.FileCopyFlags.OVERWRITE,
                            null,
                            null
                        );
                        return destPath;
                    } catch (e) {
                        // ignore copy errors and continue searching
                    }
                }
            }
        }

        return null;
    }

    _ensureStaticAppIcon(appName, gicon) {
        if (!appName)
            return null;

        const key = this._appIconCacheKey(appName);
        const cached = this._appIconCache.get(key);
        if (cached && GLib.file_test(cached, GLib.FileTest.EXISTS))
            return cached;

        const candidates = this._appIconNameCandidates(appName, gicon);
        for (const base of candidates) {
            const path = this._findOrCopyStaticAppIconByBase(base);
            if (!path)
                continue;
            this._appIconCache.set(key, path);
            return path;
        }

        return null;
    }

    _handleFocusChange() {
        const win = global.display.get_focus_window();
        const app = win ? this._windowTracker.get_window_app(win) : null;
        const appName = this._appNameFromWindow(win);

        if (appName === this._lastApp)
            return;

        this._incrementCurrent();

        this._lastApp = appName;
        this._lastAppGicon = app ? app.get_icon() : null;
        this._ensureStaticAppIcon(appName, this._lastAppGicon);
        this._lastTime = Math.floor(GLib.get_monotonic_time() / 1000000);
        this._emitUpdate();
    }

    _appNameFromWindow(win) {
        if (!win || win.minimized)
            return null;
        const app = this._windowTracker.get_window_app(win);
        if (app)
            return app.get_name();
        const wmClass = win.get_wm_class();
        if (wmClass)
            return wmClass;
        return win.get_title() || null;
    }

    _normalizeStats(statsData) {
        const apps = new Map();
        const webTotals = new Map();

        const ensureApp = appName => {
            if (!apps.has(appName))
                apps.set(appName, {total: 0, children: new Map()});
            return apps.get(appName);
        };

        if (statsData && typeof statsData === 'object' && statsData.apps && typeof statsData.apps === 'object') {
            for (const [appName, raw] of Object.entries(statsData.apps)) {
                if (typeof appName !== 'string' || appName.length === 0)
                    continue;

                const entry = ensureApp(appName);
                if (typeof raw === 'number') {
                    entry.total = Number(raw) || 0;
                    continue;
                }

                if (!raw || typeof raw !== 'object')
                    continue;

                entry.total = Number(raw.total ?? raw.seconds ?? 0) || 0;

                const childrenObj = raw.children && typeof raw.children === 'object' ? raw.children :
                    raw.web && typeof raw.web === 'object' ? raw.web : null;

                if (childrenObj) {
                    for (const [domain, secRaw] of Object.entries(childrenObj)) {
                        const sec = Number(secRaw) || 0;
                        if (!domain || sec <= 0)
                            continue;
                        entry.children.set(domain, sec);
                        webTotals.set(domain, (webTotals.get(domain) || 0) + sec);
                    }
                }
            }
        }

        if (statsData && typeof statsData === 'object' && statsData.app && typeof statsData.app === 'object') {
            for (const [appName, secRaw] of Object.entries(statsData.app)) {
                const sec = Number(secRaw) || 0;
                if (!appName || sec <= 0)
                    continue;
                const entry = ensureApp(appName);
                entry.total = Math.max(entry.total, sec);
            }
        }

        if (statsData && typeof statsData === 'object' && statsData.web && typeof statsData.web === 'object') {
            const browserParent = this._lastApp && this._isBrowserApp(this._lastApp) ? this._lastApp : 'Google Chrome';
            const entry = ensureApp(browserParent);
            for (const [domain, secRaw] of Object.entries(statsData.web)) {
                const sec = Number(secRaw) || 0;
                if (!domain || sec <= 0)
                    continue;
                const current = entry.children.get(domain) || 0;
                entry.children.set(domain, Math.max(current, sec));
                webTotals.set(domain, Math.max(webTotals.get(domain) || 0, sec));
            }

            let childrenTotal = 0;
            for (const sec of entry.children.values())
                childrenTotal += sec;
            entry.total = Math.max(entry.total, childrenTotal);
        }

        for (const [, entry] of apps.entries()) {
            let childSum = 0;
            for (const sec of entry.children.values())
                childSum += sec;
            entry.total = Math.max(entry.total, childSum);
        }

        return {apps, webTotals};
    }

    _extractCurrentDomainFromHistory(historyData) {
        if (!historyData)
            return null;

        if (typeof historyData === 'object') {
            const direct = historyData.currentDomain ?? historyData.current_domain ?? historyData.current ?? historyData.domain;
            if (typeof direct === 'string' && direct.length > 0)
                return direct;
        }

        const lists = [];
        if (Array.isArray(historyData)) {
            lists.push(historyData);
        } else if (historyData && typeof historyData === 'object') {
            for (const key of ['tabs', 'history', 'items', 'rows', 'data']) {
                if (Array.isArray(historyData[key]))
                    lists.push(historyData[key]);
            }
        }

        for (const list of lists) {
            for (const row of list) {
                if (!row || typeof row !== 'object')
                    continue;
                const isActive = Boolean(row.active ?? row.isActive ?? row.current);
                if (!isActive)
                    continue;
                const domain = row.domain ?? row.name ?? row.site ?? row.title;
                if (typeof domain === 'string' && domain.length > 0)
                    return domain;
            }

            if (list.length > 0) {
                const first = list[0];
                if (first && typeof first === 'object') {
                    const domain = first.domain ?? first.name ?? first.site ?? first.title;
                    if (typeof domain === 'string' && domain.length > 0)
                        return domain;
                }
            }
        }

        return null;
    }

    _updateCurrentDomainFromTotals(webTotals) {
        let bestDomain = null;
        let bestDelta = 0;

        for (const [domain, total] of webTotals.entries()) {
            const prev = this._lastWebTotals.get(domain) || 0;
            const delta = total - prev;
            if (delta > bestDelta) {
                bestDelta = delta;
                bestDomain = domain;
            }
        }

        this._lastWebTotals = new Map(webTotals);
        if (bestDelta > 0 && bestDomain)
            return bestDomain;
        return null;
    }

    _syncServerData() {
        this._getJson(this._statsUrl, statsData => {
            const normalized = this._normalizeStats(statsData);
            this._serverApps = normalized.apps;
            this._webTotals = normalized.webTotals;

            if (!this._currentDomain) {
                const fromTotals = this._updateCurrentDomainFromTotals(normalized.webTotals);
                if (fromTotals && this._currentDomain !== fromTotals)
                    this._currentDomain = fromTotals;
            }

            if (this._isBrowserApp(this._lastApp) && this._currentDomain)
                this._ensureSiteIcon(this._currentDomain);

            this._emitUpdate();
        });

        this._getJson(this._historyUrl, historyData => {
            const domain = this._extractCurrentDomainFromHistory(historyData);
            if (!domain)
                return;
            if (domain === this._currentDomain)
                return;
            this._currentDomain = domain;
            this._ensureSiteIcon(domain);
            this._emitUpdate();
        });
    }

    getCurrentDisplayGicon() {
        if (this._isBrowserApp(this._lastApp) && this._currentDomain) {
            const path = this._siteIconCache.get(this._currentDomain) || this._siteIconPath(this._currentDomain);
            if (path && GLib.file_test(path, GLib.FileTest.EXISTS)) {
                this._siteIconCache.set(this._currentDomain, path);
                return new Gio.FileIcon({file: Gio.File.new_for_path(path)});
            }
        }

        const staticPath = this._ensureStaticAppIcon(this._lastApp, this._lastAppGicon);
        if (staticPath)
            return new Gio.FileIcon({file: Gio.File.new_for_path(staticPath)});

        return this._lastAppGicon;
    }

    _findRunningAppGicon(appName) {
        if (!appName)
            return null;

        if (this._lastApp && appName.toLowerCase() === this._lastApp.toLowerCase() && this._lastAppGicon)
            return this._lastAppGicon;

        try {
            const appSystem = Shell.AppSystem.get_default();
            const running = appSystem ? appSystem.get_running() : [];
            for (const app of running) {
                if (!app)
                    continue;
                const name = app.get_name();
                if (!name)
                    continue;
                if (name.toLowerCase() !== String(appName).toLowerCase())
                    continue;
                return app.get_icon();
            }
        } catch (e) {
            // ignore icon lookup failures
        }

        return null;
    }

    getRowGicon(rowName) {
        const runningGicon = this._findRunningAppGicon(rowName);
        const staticPath = this._ensureStaticAppIcon(rowName, runningGicon);
        if (staticPath)
            return new Gio.FileIcon({file: Gio.File.new_for_path(staticPath)});
        return runningGicon;
    }

    getDomainGicon(domain) {
        if (!domain)
            return null;

        this._ensureSiteIcon(domain);
        const path = this._siteIconCache.get(domain) || this._siteIconPath(domain);
        if (!path)
            return null;
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            return null;

        this._siteIconCache.set(domain, path);
        return new Gio.FileIcon({file: Gio.File.new_for_path(path)});
    }

    getCurrentDisplayName() {
        if (this._isBrowserApp(this._lastApp) && this._currentDomain)
            return this._currentDomain;
        return this._lastApp;
    }

    getCurrentDisplaySeconds() {
        if (this._isBrowserApp(this._lastApp) && this._currentDomain) {
            for (const [appName, entry] of this._serverApps.entries()) {
                if (!this._isBrowserApp(appName))
                    continue;
                const sec = entry.children.get(this._currentDomain) || 0;
                if (sec > 0)
                    return sec;
            }
            return this._webTotals.get(this._currentDomain) || 0;
        }

        if (!this._lastApp)
            return 0;

        if (this._serverApps.has(this._lastApp))
            return this._serverApps.get(this._lastApp).total;

        let local = this._usageMap.get(this._lastApp) || 0;
        const now = Math.floor(GLib.get_monotonic_time() / 1000000);
        if (this._lastTime > 0)
            local += (now - this._lastTime);
        return local;
    }

    isAppActive(appName) {
        if (!appName || !this._lastApp)
            return false;
        return appName.toLowerCase() === this._lastApp.toLowerCase();
    }

    getUsageTree(limitChildren) {
        const rows = [];

        for (const [appName, entry] of this._serverApps.entries()) {
            const children = Array.from(entry.children.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, limitChildren)
                .map(([name, seconds]) => ({name, seconds}));

            rows.push({
                name: appName,
                total: entry.total,
                children,
            });
        }

        if (rows.length === 0) {
            for (const [appName, sec] of this._usageMap.entries())
                rows.push({name: appName, total: sec, children: []});
        }

        rows.sort((a, b) => b.total - a.total);
        return rows;
    }

    _startServerProcess() {
        if (!GLib.file_test(this._serverBinaryPath, GLib.FileTest.EXISTS | GLib.FileTest.IS_EXECUTABLE)) {
            Main.notify('App Usage Tracker', 'Server binary not found or not executable.');
            return false;
        }

        try {
            const [, pid] = GLib.spawn_async(
                null,
                [this._serverBinaryPath],
                null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null
            );
            GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, () => {});
            return true;
        } catch (e) {
            log('[AppUsageTracker] Failed to start server: ' + e);
            Main.notify('App Usage Tracker', 'Could not start local server.');
            return false;
        }
    }

    _openDashboard() {
        try {
            Gio.AppInfo.launch_default_for_uri(this._dashboardUrl, null);
        } catch (e) {
            log('[AppUsageTracker] Failed to open dashboard: ' + e);
            Main.notify('App Usage Tracker', 'Could not open dashboard URL.');
        }
    }

    openDashboard() {
        this._getJson(this._statsUrl, stats => {
            if (stats) {
                this._openDashboard();
                return;
            }

            if (!this._settings.getAutoStartServer()) {
                Main.notify('App Usage Tracker', 'Server is offline and auto-start is disabled in Preferences.');
                return;
            }

            if (!this._startServerProcess())
                return;

            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._openDashboard();
                return GLib.SOURCE_REMOVE;
            });
        });
    }
}

function trimText(value, maxLength = 26) {
    if (!value)
        return '--';
    if (value.length <= maxLength)
        return value;
    return `${value.slice(0, maxLength - 3)}...`;
}

function formatTime(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);

    if (h > 0)
        return `${h}h`;
    return `${m}m`;
}

function createInfoItem(text) {
    return createMenuItemWithIcon(text, {
        reactive: false,
        canFocus: false,
        iconName: 'dialog-information-symbolic',
    });
}

function createMenuItemWithIcon(text, options = {}) {
    const reactive = options.reactive ?? true;
    const canFocus = options.canFocus ?? reactive;
    const gicon = options.gicon ?? null;
    const iconName = options.iconName ?? 'application-x-executable-symbolic';

    const item = new PopupMenu.PopupBaseMenuItem({
        reactive,
        can_focus: canFocus,
    });

    const iconProps = {
        icon_size: 16,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: 'app-usage-menu-icon',
    };
    const icon = gicon ? new St.Icon({...iconProps, gicon}) : new St.Icon({...iconProps, icon_name: iconName});

    const label = new St.Label({
        text,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        style_class: 'app-usage-menu-label',
    });

    item.add_child(icon);
    item.add_child(label);
    return item;
}

const UsageIndicator = GObject.registerClass(class UsageIndicator extends PanelMenu.Button {
    constructor(tracker, settings) {
        super(0.0, 'App Usage Tracker', false);

        this._tracker = tracker;
        this._settings = settings;
        this._collapsed = new Set();
        this._menuRefreshId = 0;

        this._icon = new St.Icon({
            icon_name: 'applications-system-symbolic',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'app-usage-indicator-icon',
        });

        this._label = new St.Label({
            text: '—',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'app-usage-indicator-label',
        });

        this._container = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'app-usage-indicator-box',
        });
        this._container.add_child(this._icon);
        this._container.add_child(this._label);

        this.add_child(this._container);
        this._refresh();

        this._menuRefreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _renderMenu() {
        this.menu.removeAll();

        const rows = this._tracker.getUsageTree(this._settings.getChildLimit());

        if (rows.length === 0) {
            this.menu.addMenuItem(createInfoItem('No activity yet'));
        } else {
            for (const row of rows) {
                const isActive = this._tracker.isAppActive(row.name);
                const hasChildren = row.children.length > 0;
                const isCollapsed = this._collapsed.has(row.name);
                const arrow = hasChildren ? (isCollapsed ? '▸' : '▾') : ' ';
                const marker = isActive ? '●' : ' ';

                if (!hasChildren)
                    this._collapsed.delete(row.name);

                const rowGicon = this._tracker.getRowGicon(row.name);
                const parentItem = createMenuItemWithIcon(
                    `${marker} ${arrow} ${trimText(row.name, 18)}  ${formatTime(row.total)}`,
                    {
                        reactive: hasChildren,
                        canFocus: hasChildren,
                        gicon: rowGicon,
                        iconName: this._tracker._isBrowserApp(row.name) ? 'web-browser-symbolic' : 'application-x-executable-symbolic',
                    }
                );

                if (hasChildren) {
                    parentItem.connect('activate', () => {
                        if (isCollapsed)
                            this._collapsed.delete(row.name);
                        else
                            this._collapsed.add(row.name);
                        this._renderMenu();
                    });
                }

                this.menu.addMenuItem(parentItem);

                if (hasChildren && !isCollapsed) {
                    for (const child of row.children) {
                        const childGicon = this._tracker.getDomainGicon(child.name);
                        this.menu.addMenuItem(
                            createMenuItemWithIcon(
                                `   ↳ ${trimText(child.name, 20)}  ${formatTime(child.seconds)}`,
                                {
                                    reactive: false,
                                    canFocus: false,
                                    gicon: childGicon,
                                    iconName: 'web-browser-symbolic',
                                }
                            )
                        );
                    }
                }
            }
        }

        const dashboardItem = new PopupMenu.PopupMenuItem('Open Dashboard');
        dashboardItem.connect('activate', () => {
            this._tracker.openDashboard();
        });
        this.menu.addMenuItem(dashboardItem);
    }

    _refresh() {
        const gicon = this._tracker.getCurrentDisplayGicon();
        if (gicon)
            this._icon.gicon = gicon;
        else
            this._icon.icon_name = 'applications-system-symbolic';

        const name = this._tracker.getCurrentDisplayName();
        if (!name) {
            this._label.set_text('—');
        } else {
            const sec = this._tracker.getCurrentDisplaySeconds();
            this._label.set_text(`${trimText(name, 14)} — ${formatTime(sec)}`);
        }

        this._renderMenu();
    }

    update() {
        this._refresh();
    }

    destroy() {
        if (this._menuRefreshId) {
            GLib.Source.remove(this._menuRefreshId);
            this._menuRefreshId = 0;
        }
        super.destroy();
    }
});

export default class AppUsageTrackerExtension extends Extension {
    enable() {
        this._settings = new TrackerSettings();
        this._tracker = new AppUsageTracker(this.uuid, this.path, this._settings);
        this._indicator = new UsageIndicator(this._tracker, this._settings);

        this._tracker.setUpdateCallback(() => {
            if (this._indicator)
                this._indicator.update();
        });

        const position = this._settings.getIndicatorPosition();
        this._addIndicatorToPanel(this._indicator, position);

        this._tracker.enable();
    }

    _leftBoxIndexAfterWindowMenu() {
        const leftBox = Main.panel._leftBox;
        if (!leftBox)
            return 0;

        const children = leftBox.get_children();
        const statusArea = Main.panel.statusArea || {};
        const anchorRoles = ['windowMenu', 'appMenu', 'activities'];

        for (const role of anchorRoles) {
            const anchor = statusArea[role];
            if (!anchor || !anchor.container)
                continue;
            const idx = children.indexOf(anchor.container);
            if (idx >= 0)
                return idx + 1;
        }

        return children.length > 0 ? 1 : 0;
    }

    _rightBoxIndexAfterAppIndicator() {
        const rightBox = Main.panel._rightBox;
        if (!rightBox)
            return 0;

        const children = rightBox.get_children();
        const statusArea = Main.panel.statusArea || {};
        const appIndicatorRoles = ['appindicator', 'AppIndicator'];

        for (const role of appIndicatorRoles) {
            const indicator = statusArea[role];
            if (!indicator || !indicator.container)
                continue;
            const idx = children.indexOf(indicator.container);
            if (idx >= 0)
                return idx + 1;
        }

        return children.length;
    }

    _addIndicatorToPanel(indicator, position) {
        if (position === 'left') {
            Main.panel.addToStatusArea(this.uuid, indicator, this._leftBoxIndexAfterWindowMenu(), 'left');
            return;
        }

        if (position === 'center') {
            Main.panel.addToStatusArea(this.uuid, indicator, 0, 'center');
            return;
        }

        Main.panel.addToStatusArea(this.uuid, indicator, this._rightBoxIndexAfterAppIndicator(), 'right');
    }

    disable() {
        if (this._tracker) {
            this._tracker.disable();
            this._tracker = null;
        }

        this._settings = null;

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
