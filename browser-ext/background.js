const SERVER_URL = "http://127.0.0.1:7878/track";
const ACTIVE_URL = "http://127.0.0.1:7878/active-web";

let currentDomain = null;
let isIdle = false;
let lastSentActiveDomain = null;

function detectParentApp() {
  const ua = navigator.userAgent || '';
  if (ua.includes('Brave')) return 'Brave Web Browser';
  if (ua.includes('Chromium')) return 'Chromium';
  return 'Google Chrome';
}

const PARENT_APP = detectParentApp();

function postActiveDomain(domain) {
  if (domain === lastSentActiveDomain) {
    return;
  }

  lastSentActiveDomain = domain;

  fetch(ACTIVE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app: PARENT_APP,
      domain: domain || ''
    })
  }).catch(() => {
    // Ignore errors (server might be down)
  });
}

// Helpers to extract domain from URL
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

// Update the current tracked domain based on active tab
async function updateCurrentTab() {
  if (isIdle) {
    currentDomain = null;
    postActiveDomain(null);
    return;
  }

  const queryOptions = { active: true, lastFocusedWindow: true };
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

// Track active tab changes
chrome.tabs.onActivated.addListener(updateCurrentTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && changeInfo.url) {
    updateCurrentTab();
  }
});
chrome.windows.onFocusChanged.addListener(updateCurrentTab);

// Watch for system idle state (e.g. away from keyboard)
chrome.idle.setDetectionInterval(600);
chrome.idle.onStateChanged.addListener((newState) => {
  isIdle = (newState === "idle" || newState === "locked");
  updateCurrentTab();
});

// Periodic tracking loop (every 1 second)
setInterval(() => {
  if (currentDomain) {
    fetch(SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'web',
        app: PARENT_APP,
        name: currentDomain,
        duration: 1
      })
    }).catch(() => {
      // Ignore errors (server might be down)
    });
  }
}, 1000);

// Initial call
updateCurrentTab();
