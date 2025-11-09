// background.js — Main background script that imports and initializes other background scripts

// Import the background scripts
import './upload-bg.js';
import './crop-bg.js';

console.log('Main background script loaded');

// Centralized server URL (loaded from storage)
let SERVER_URL = 'http://127.0.0.1:8000';

// Load server URL from storage
chrome.storage.sync.get({ serverUrl: SERVER_URL }, (items) => {
  if (items && items.serverUrl) {
    SERVER_URL = items.serverUrl;
    console.log('Server URL loaded from storage:', SERVER_URL);
  }
});

// Listen to options updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'settingsUpdated' && msg.settings?.serverUrl) {
    SERVER_URL = msg.settings.serverUrl;
    console.log('Server URL updated from options:', SERVER_URL);
  }
});

// Handle extension installation and updates
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Extension installed');
    // Set default settings
    chrome.storage.sync.set({
      serverUrl: 'http://127.0.0.1:8000',
      autoScan: true,
      showNotifications: true
    });
  } else if (details.reason === 'update') {
    console.log(`Extension updated from ${details.previousVersion} to ${chrome.runtime.getManifest().version}`);
  }
});

// Handle extension startup
chrome.runtime.onStartup.addListener(() => {
  console.log('Extension starting up...');
});

// Handle extension uninstall (for cleanup if needed)
chrome.runtime.setUninstallURL('https://example.com/uninstall-feedback');

// Listen for messages that need to be handled by both scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Add any global message handlers here
  if (request.action === 'checkServerStatus') {
    checkServerStatus().then(isRunning => {
      sendResponse({ isRunning });
    });
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'analyzeImage') {
    // request.imageData is a data URL (base64) from content-facebook.js
    (async () => {
      try {
        const blob = dataURLToBlob(request.imageData);
        const formData = new FormData();
        formData.append('file', new File([blob], 'upload.jpg', { type: blob.type || 'image/jpeg' }));

        const resp = await fetch(`${SERVER_URL}/classify/file`, {
          method: 'POST',
          body: formData
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new Error(`Server ${resp.status} ${resp.statusText} ${text}`);
        }

        const result = await resp.json();
        sendResponse({ success: true, result });
      } catch (e) {
        console.error('analyzeImage failed:', e);
        sendResponse({ success: false, error: e.message || 'Analyze failed' });
      }
    })();
    return true; // async
  }

  if (request.action === 'classifyUrl' && request.url) {
    (async () => {
      try {
        const resp = await fetch(`${SERVER_URL}/classify/url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: request.url, use_vit: true, use_efficientnet: true })
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new Error(`Server ${resp.status} ${resp.statusText} ${text}`);
        }

        const result = await resp.json();
        sendResponse({ success: true, result });
      } catch (e) {
        console.error('classifyUrl failed:', e);
        sendResponse({ success: false, error: e.message || 'Classify URL failed' });
      }
    })();
    return true; // async
  }
});

// Shared server status check function
async function checkServerStatus() {
  try {
    const response = await fetch(`${SERVER_URL}/health`, { method: 'GET' });
    return response.ok;
  } catch (error) {
    console.error('Server status check failed:', error);
    return false;
  }
}

// Periodically check server status
setInterval(async () => {
  const isServerRunning = await checkServerStatus();
  if (!isServerRunning) {
    console.log('Server is not running');
    // You could show a notification to the user here
  }
}, 30000); // Check every 30 seconds

// Helpers
function dataURLToBlob(dataUrl) {
  // data:[<mediatype>][;base64],<data>
  const [meta, base64] = dataUrl.split(',');
  const mimeMatch = /data:([^;]+);base64/.exec(meta);
  const mime = (mimeMatch && mimeMatch[1]) || 'image/jpeg';
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
