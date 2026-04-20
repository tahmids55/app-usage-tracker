const ACTIVE_URL = "http://127.0.0.1:7878/active-web";
const KEEPALIVE_ALARM_NAME = "keepalive";
const KEEPALIVE_INTERVAL_MINUTES = 0.4; // ~25 seconds — keeps service worker alive

let currentDomain = null;
let isBrowserFocused = false;
let focusedWindowId = chrome.windows.WINDOW_ID_NONE;
let lastConfirmedActiveDomain = null;
let pendingActiveDomain = undefined;
let activeDomainPostInFlight = false;

function detectParentApp() {
  const ua = navigator.userAgent || '';
  if (ua.includes('Brave')) return 'Brave Web Browser';
  if (ua.includes('Chromium')) return 'Chromium';
  return 'Google Chrome';
}

const PARENT_APP = detectParentApp();

function postActiveDomain(domain) {
  const normalizedDomain = domain || null;

  if (normalizedDomain === lastConfirmedActiveDomain && !activeDomainPostInFlight) {
    return;
  }

  pendingActiveDomain = normalizedDomain;
  if (activeDomainPostInFlight)
    return;

  const drain = () => {
    if (pendingActiveDomain === undefined) {
      activeDomainPostInFlight = false;
      return;
    }

    const toSend = pendingActiveDomain;
    pendingActiveDomain = undefined;
    activeDomainPostInFlight = true;

    fetch(ACTIVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: PARENT_APP,
        domain: toSend || ''
      })
    }).then(() => {
      lastConfirmedActiveDomain = toSend;
    }).catch(() => {
      if (pendingActiveDomain === undefined)
        pendingActiveDomain = toSend;
    }).finally(() => {
      setTimeout(drain, 100);
    });
  };

  drain();
}

function getDomain(urlStr) {
  try {
    const url = new URL(urlStr);
    if (!url.protocol.startsWith('http')) return null;
    let hostname = url.hostname;
    if (hostname.startsWith('www.')) hostname = hostname.substring(4);
    return hostname;
  } catch (e) {
    return null;
  }
}

async function updateCurrentTab() {
  if (!isBrowserFocused) {
    currentDomain = null;
    postActiveDomain(null);
    return;
  }

  const queryOptions = focusedWindowId === chrome.windows.WINDOW_ID_NONE
    ? { active: true, lastFocusedWindow: true }
    : { active: true, windowId: focusedWindowId };

  try {
    const [tab] = await chrome.tabs.query(queryOptions);
    if (tab && tab.url) {
      currentDomain = getDomain(tab.url);
    } else {
      currentDomain = null;
    }
  } catch (e) {
    currentDomain = null;
  }

  postActiveDomain(currentDomain);
}

// --- Event listeners ---

chrome.tabs.onActivated.addListener(activeInfo => {
  if (focusedWindowId !== chrome.windows.WINDOW_ID_NONE && activeInfo.windowId !== focusedWindowId)
    return;
  updateCurrentTab();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab || !tab.active)
    return;

  if (focusedWindowId !== chrome.windows.WINDOW_ID_NONE && tab.windowId !== focusedWindowId)
    return;

  if (changeInfo.url || changeInfo.status === 'complete') {
    updateCurrentTab();
  }
});

chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    isBrowserFocused = false;
    focusedWindowId = windowId;
    currentDomain = null;
    postActiveDomain(null);
    return;
  }

  isBrowserFocused = true;
  focusedWindowId = windowId;
  updateCurrentTab();
});

// --- Keep-alive alarm ---
// Chrome suspends MV3 service workers after ~30s of inactivity.
// This alarm fires every ~25s to re-check and re-post the current domain,
// preventing stale domain counting on the server when the user is idle
// but still has the browser focused.

chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
  periodInMinutes: KEEPALIVE_INTERVAL_MINUTES,
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== KEEPALIVE_ALARM_NAME)
    return;

  // Force a fresh check: re-read the focused window state and active tab,
  // then re-post to the server. This handles the case where the service
  // worker was suspended and woke up to this alarm — the in-memory state
  // (isBrowserFocused, currentDomain) may be stale after suspension.
  chrome.windows.getLastFocused({ populate: false }, win => {
    if (!win || chrome.runtime.lastError || !win.focused) {
      isBrowserFocused = false;
      focusedWindowId = chrome.windows.WINDOW_ID_NONE;
      currentDomain = null;
      // Explicitly tell the server no domain is active
      lastConfirmedActiveDomain = '__force_resend__';
      postActiveDomain(null);
    } else {
      isBrowserFocused = true;
      focusedWindowId = win.id;
      // Force resend even if domain hasn't changed, since the server
      // may have cleared state during our suspension
      lastConfirmedActiveDomain = '__force_resend__';
      updateCurrentTab();
    }
  });
});

// --- Initial state on load ---

chrome.windows.getLastFocused({ populate: false }, win => {
  if (!win || chrome.runtime.lastError || !win.focused) {
    isBrowserFocused = false;
    focusedWindowId = chrome.windows.WINDOW_ID_NONE;
  } else {
    isBrowserFocused = true;
    focusedWindowId = win.id;
  }

  updateCurrentTab();
});
