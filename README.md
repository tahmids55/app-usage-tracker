# App Usage Tracker

This project is a local-first desktop and web activity tracker built from three pieces:

1. A GNOME Shell extension for focused app tracking and top-bar UI.
2. A browser extension for active website domain tracking.
3. A lightweight C++ local server for aggregation, persistence, and dashboard APIs.

If your goal is learning, this README explains both what the system does and how to build a similar system as a software engineer, step by step.

## What This Extension Does

At runtime, the stack tracks usage in one-second increments and keeps all data local to your machine.

Current behavior highlights:

1. Server-side counting runs every second.
2. Panel and dashboard refresh every second.
3. Browser domains are isolated by browser family (for example, Chrome vs Brave).
4. The top panel and dashboard are aligned to the same daily data source to avoid drift.
5. Counting does not pause based on idle state in this version.

## Architecture

### Components

1. `extension.js`
  - GNOME top-bar indicator and popup menu.
  - Reads live stats from server endpoints.
  - Detects focused app and posts active state.

2. `browser-ext/background.js`
  - Detects active tab domain in a Chromium-based browser.
  - Posts active domain updates to the local server.
  - Includes keep-alive alarm logic for MV3 service worker behavior.

3. `server/server.cpp`
  - Owns the source of truth for time counting.
  - Tracks active app + per-browser active domain.
  - Serves API endpoints and dashboard static files.
  - Persists data into local JSON files.

4. `dashboard/index.html` and `dashboard/app.js`
  - Displays daily usage analytics, trend bars, and per-app/domain breakdowns.

## Data Flow (End to End)

1. GNOME extension observes focused app changes and sends app state to `POST /state`.
2. Browser extension observes active tab changes and sends domain state to `POST /active-web`.
3. Server tick loop runs every second and increments counters for the currently focused app.
4. If focused app is a browser and a domain is active for that browser family, server increments that domain child counter too.
5. GNOME panel requests daily stats and history every second for display.
6. Dashboard requests daily stats every second for visualizations.
7. Server autosaves to disk every minute and on shutdown.

## File and Data Model

High-level server model:

1. `apps[appName].total`
  - Total seconds for app.
2. `apps[appName].children[domain]`
  - Per-domain seconds under that app (browser apps only).
3. `dailyApps[YYYY-MM-DD][appName]`
  - Daily scoped totals and children.
4. `currentApp`
  - Current focused app name.
5. `currentWebDomainByBrowser[browserFamily]`
  - Current active domain per browser family.

Persistence paths:

1. `~/.local/share/usage-tracker/stats.json`
2. `~/.local/share/usage-tracker/daily-stats.json`

## HTTP API

### State/Tracking Endpoints

1. `POST /state`
  - Used by GNOME extension to set active app.

2. `POST /active-web`
  - Used by browser extension to set active domain for browser family.

3. `POST /track`
  - Legacy-compatible state endpoint retained for compatibility.

4. `POST /reset-today`
  - Clears current-day data.

### Read Endpoints

1. `GET /stats`
  - Lifetime aggregate stats.

2. `GET /daily?date=today`
  - Daily aggregate stats for dashboard/panel alignment.

3. `GET /daily-dates`
  - List of tracked dates.

4. `GET /history`
  - Current app/domain context + merged domain history rows.

5. `GET /dashboard`
  - Serves dashboard UI.

## How to Run

### 1) Build and Start Server

Run from `server/`:

1. `g++ -std=c++17 -pthread -O2 -o usage-tracker-server server.cpp`
2. `./usage-tracker-server`

Optional background mode:

1. `nohup ./usage-tracker-server > server.log 2>&1 &`

Quick check:

1. `curl http://127.0.0.1:7878/stats`

### 2) Load GNOME Extension

This folder is already in a local extension layout with UUID `app-usage-tracker@local`.

Enable using GNOME Extensions app or CLI tools.

### 3) Load Browser Extension

For Chrome/Brave/Chromium:

1. Open browser extensions page.
2. Enable Developer Mode.
3. Load unpacked from `browser-ext/`.

## Learning Path: Build This as an Engineer

Use this as a practical blueprint for building systems that combine desktop, browser, backend, and UI.

### Phase 1: Define the Contract First

1. Define your domain entities: app, domain child, total seconds, daily total.
2. Define API endpoints before coding UI.
3. Decide one source of truth for counting (server tick loop).
4. Write down edge cases:
  - Browser service-worker sleep.
  - Focus changes between app and browser.
  - App name variations across environments.

### Phase 2: Build the Local Server

1. Implement a tiny HTTP server and endpoint router.
2. Implement shared in-memory store guarded by mutex.
3. Implement one-second tick loop for deterministic counting.
4. Add daily partitioning and autosave.
5. Add compatibility parsers for evolving JSON schema.

Engineering lessons:

1. Keep counting in one place to prevent double counting.
2. Separate state updates from duration updates.
3. Ensure every endpoint is tolerant to partial/legacy payloads.

### Phase 3: Build Browser Active-Domain Signal

1. Detect active tab domain from URL.
2. Ignore unsupported protocols.
3. Post active domain changes to server.
4. Add periodic keepalive alarm for MV3 worker wakeups.
5. Handle Brave vs Chrome identity robustly.

Engineering lessons:

1. Browser runtime lifecycle can drop volatile state.
2. Explicit re-posting is safer than assuming always-on workers.

### Phase 4: Build GNOME Focus Signal + Panel UI

1. Detect focused window and resolve app name.
2. Post app state to server.
3. Pull data on a fixed cadence for display.
4. Render top app rows and nested domain rows.
5. Add icon fallback chain (themed icons, copied static icons, file icons).

Engineering lessons:

1. UI should read the same data contract as analytics views.
2. Keep UI reactive but avoid inventing unsynchronized local totals.

### Phase 5: Build Dashboard Analytics

1. Normalize API payloads into deterministic view model.
2. Render totals, donut, legends, trend bars.
3. Support day navigation via `GET /daily?date=` and `GET /daily-dates`.
4. Keep refresh interval aligned with panel if consistency is required.

Engineering lessons:

1. Visualizations are only as good as normalization logic.
2. Date handling must be explicit and local-time aware.

### Phase 6: Hardening and Correctness

1. Separate domains by browser family to avoid cross-browser mixing.
2. Keep compatibility paths for old payload formats.
3. Make refresh cadence explicit and centralized.
4. Add logging around state transitions and endpoint failures.
5. Validate with realistic manual scenarios:
  - Alternate Chrome and Brave with different sites.
  - Switch rapidly between browser and non-browser apps.
  - Restart server while extensions are running.

## Practical Debug Checklist

If numbers look wrong, check in this order:

1. Server is running and reachable on `127.0.0.1:7878`.
2. Browser extension is loaded and has host permission.
3. GNOME extension is enabled and posting state.
4. `GET /history` reflects expected `currentApp` and `currentDomain`.
5. `GET /daily?date=today` contains expected app/domain rows.
6. Panel and dashboard both refreshing at 1-second cadence.

## Suggested Next Learning Improvements

1. Add unit tests for JSON normalization and parser fallback behavior.
2. Add a replayable integration test script that posts synthetic state transitions.
3. Add trace endpoint for recent state transitions to ease debugging.
4. Add explicit schema version in persisted files.
5. Add optional export to CSV for analytics.

## License and Safety Notes

1. This project is local-first and binds to loopback address only.
2. Review data retention files before sharing logs or persisted JSON.
