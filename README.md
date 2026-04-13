# App Usage Tracker

A local-first activity tracker that combines:

- a GNOME Shell extension for desktop app focus time,
- a browser extension for active website domain time,
- a lightweight C++ HTTP server that aggregates and persists usage stats.

The server listens on `127.0.0.1:7878` and stores totals in `~/.local/share/usage-tracker/stats.json`.

## Project Structure

- `extension.js`: GNOME Shell extension entry point and UI panel indicator.
- `metadata.json`: GNOME extension metadata (UUID, supported Shell versions, etc.).
- `stylesheet.css`: panel label styling for the GNOME indicator.
- `browser-ext/manifest.json`: browser extension manifest (MV3).
- `browser-ext/background.js`: tracks active tab domain and posts 1-second web usage increments.
- `server/server.cpp`: local HTTP server that accepts tracking events and serves stats.
- `server/usage-tracker-server`: compiled Linux server binary.
- `server/server.log`: sample runtime output from a previous server run.

## How It Works

### 1) Desktop app tracking (GNOME)

The GNOME extension in `extension.js`:

- listens for focused window changes,
- computes elapsed active time for the previously focused app,
- posts app usage deltas to `POST /track` as:

```json
{ "type": "app", "name": "App Name", "duration": 12 }
```

It also adds a top-bar indicator that shows:

- current app and its elapsed usage,
- total tracked active time,
- top 5 apps by usage.

### 2) Website tracking (browser)

The browser extension in `browser-ext/background.js`:

- resolves active tab hostname (strips `www.`),
- ignores non-http(s) URLs,
- clears current domain when system is idle/locked,
- every second posts web usage increments:

```json
{ "type": "web", "name": "example.com", "duration": 1 }
```

### 3) Aggregation and persistence (C++ server)

The server in `server/server.cpp`:

- binds to `127.0.0.1:7878`,
- accepts CORS-enabled requests,
- updates in-memory counters for `app` and `web`,
- exposes `GET /stats` with combined totals,
- autosaves every 60 seconds and on shutdown.

Persistence location:

- `~/.local/share/usage-tracker/stats.json`

## HTTP API

### `POST /track`

Body:

```json
{ "type": "app|web", "name": "string", "duration": 1 }
```

Behavior:

- `type = app` updates app totals.
- `type = web` updates web totals.
- Empty names or non-positive durations are ignored.

Response:

```json
{ "ok": true }
```

### `GET /stats`

Response shape:

```json
{
  "app": {
    "Firefox": 120,
    "Code": 540
  },
  "web": {
    "github.com": 200,
    "stackoverflow.com": 80
  }
}
```

## Setup

### 1) Build and run the server

From `server/`:

```bash
g++ -std=c++17 -pthread -O2 -o usage-tracker-server server.cpp
./usage-tracker-server
```

Optional background run:

```bash
nohup ./usage-tracker-server > server.log 2>&1 &
```

Check stats endpoint:

```bash
curl http://127.0.0.1:7878/stats
```

### 2) Install/enable GNOME extension

This folder is already structured like a local GNOME extension directory using UUID:

- `app-usage-tracker@local`

Supported Shell versions in metadata:

- 45, 46, 47, 48

Enable it using your normal GNOME extension workflow (Extensions app or CLI tooling).

### 3) Load browser extension (Chromium-based)

1. Open extensions page.
2. Enable Developer mode.
3. Load unpacked extension from:
   - `browser-ext/`

The extension requires:

- `tabs`, `activeTab`, `idle` permissions,
- host access to `http://127.0.0.1:7878/*`.

## Runtime Notes

- Tracking is local-only by default (`127.0.0.1`).
- The checked-in `server/usage-tracker-server` is an x86-64 Linux ELF binary.
- `server/server.log` currently shows one clean start and stop cycle.

## Troubleshooting

- If no data appears, ensure the server is running before enabling the GNOME/browser extensions.
- If browser stats are missing, verify the browser extension is loaded and has host permission for `127.0.0.1:7878`.
- If app stats are missing, verify the GNOME extension is enabled and Shell version is supported.
- If `bind() failed on port 7878`, another process is already using that port.
