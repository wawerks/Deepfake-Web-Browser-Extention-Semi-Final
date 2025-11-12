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

// Also react to storage changes and broadcast latest settings
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const settings = {};
    Object.keys(changes || {}).forEach((k) => { settings[k] = changes[k]?.newValue; });
    if (Object.keys(settings).length === 0) return;
    // Keep local SERVER_URL in sync if present
    if (typeof settings.serverUrl === 'string') {
      SERVER_URL = settings.serverUrl;
      console.log('Server URL updated from storage change:', SERVER_URL);
    }
    try {
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach((t) => {
          try { chrome.tabs.sendMessage(t.id, { type: 'settingsUpdated', settings }); } catch (_) {}
        });
      });
    } catch (_) {}
  });
} catch (_) {}

// Listen to options updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'settingsUpdated' && msg.settings?.serverUrl) {
    SERVER_URL = msg.settings.serverUrl;
    console.log('Server URL updated from options:', SERVER_URL);
  }
  // Broadcast settings updates to all tabs so content scripts react without reload
  if (msg && msg.type === 'settingsUpdated' && msg.settings) {
    try {
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach((t) => {
          try { chrome.tabs.sendMessage(t.id, { type: 'settingsUpdated', settings: msg.settings }); } catch (_) {}
        });
      });
    } catch (_) {}
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
    (async () => {
      try {
        try { chrome.storage?.local?.set({ lastToast: { title: 'AI Image Guard', message: 'Analyzing image', type: 'info', ts: Date.now() } }); } catch (_) {}
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
        const confVal = Number(result?.confidence);
        if (!isFinite(confVal) || confVal <= 0 || result?.error) {
          try { chrome.storage?.local?.set({ lastToast: { title: 'Analysis unavailable', message: String(result?.error || 'Service limit reached or invalid response'), type: 'error', ts: Date.now() } }); } catch (_) {}
          sendResponse({ success: false, error: String(result?.error || 'Invalid result') });
          return;
        }
        try {
          const confidencePct = Math.round(((result?.confidence) || 0) * 100);
          const complement = Math.max(0, 100 - confidencePct);
          if (result?.is_fake) {
            chrome.storage?.local?.set({ lastToast: { title: 'Likely AI-generated', message: `Confidence: ${confidencePct}%\nReal: ${complement}%`, type: 'warning', ts: Date.now() } });
          } else if (result?.no_face) {
            chrome.storage?.local?.set({ lastToast: { title: 'Analysis complete', message: 'No face detected in the image', type: 'info', ts: Date.now() } });
          } else {
            chrome.storage?.local?.set({ lastToast: { title: 'Likely real', message: `Confidence: ${confidencePct}%\nAI: ${complement}%`, type: 'success', ts: Date.now() } });
          }
        } catch (_) {}
        sendResponse({ success: true, result });
      } catch (e) {
        console.error('analyzeImage failed:', e);
        try { chrome.storage?.local?.set({ lastToast: { title: 'Analysis error', message: String(e?.message || 'Analyze failed'), type: 'error', ts: Date.now() } }); } catch (_) {}
        sendResponse({ success: false, error: e.message || 'Analyze failed' });
      }
    })();
    return true; // async
  }

  if (request.action === 'classifyUrl' && request.url) {
    (async () => {
      try {
        try { chrome.storage?.local?.set({ lastToast: { title: 'AI Image Guard', message: 'Analyzing image', type: 'info', ts: Date.now() } }); } catch (_) {}
        let blob;
        try {
          const imgResp = await fetch(request.url, { mode: 'cors' });
          if (!imgResp.ok) throw new Error(`Image fetch ${imgResp.status}`);
          blob = await imgResp.blob();
        } catch (e) {
          blob = null;
        }

        if (blob && (blob.size === undefined || blob.size > 0)) {
          const formData = new FormData();
          formData.append('file', new File([blob], 'url-image.jpg', { type: blob.type || 'image/jpeg' }));
          const resp = await fetch(`${SERVER_URL}/classify/file`, {
            method: 'POST',
            body: formData
          });
          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`Server ${resp.status} ${resp.statusText} ${text}`);
          }
          const result = await resp.json();
          const confVal = Number(result?.confidence);
          if (!isFinite(confVal) || confVal <= 0 || result?.error) {
            try { chrome.storage?.local?.set({ lastToast: { title: 'Analysis unavailable', message: String(result?.error || 'Service limit reached or invalid response'), type: 'error', ts: Date.now() } }); } catch (_) {}
            sendResponse({ success: false, error: String(result?.error || 'Invalid result') });
            return;
          }
          try {
            const confidencePct = Math.round(((result?.confidence) || 0) * 100);
            const complement = Math.max(0, 100 - confidencePct);
            if (result?.is_fake) {
              chrome.storage?.local?.set({ lastToast: { title: 'Likely AI-generated', message: `Confidence: ${confidencePct}%\nReal: ${complement}%`, type: 'warning', ts: Date.now() } });
            } else if (result?.no_face) {
              chrome.storage?.local?.set({ lastToast: { title: 'Analysis complete', message: 'No face detected in the image', type: 'info', ts: Date.now() } });
            } else {
              chrome.storage?.local?.set({ lastToast: { title: 'Likely real', message: `Confidence: ${confidencePct}%\nAI: ${complement}%`, type: 'success', ts: Date.now() } });
            }
          } catch (_) {}
          sendResponse({ success: true, result });
          return;
        }

        // Fallback: use server URL path
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
        const confVal = Number(result?.confidence);
        if (!isFinite(confVal) || confVal <= 0 || result?.error) {
          try { chrome.storage?.local?.set({ lastToast: { title: 'Analysis unavailable', message: String(result?.error || 'Service limit reached or invalid response'), type: 'error', ts: Date.now() } }); } catch (_) {}
          sendResponse({ success: false, error: String(result?.error || 'Invalid result') });
          return;
        }
        try {
          const confidencePct = Math.round(((result?.confidence) || 0) * 100);
          const complement = Math.max(0, 100 - confidencePct);
          if (result?.is_fake) {
            chrome.storage?.local?.set({ lastToast: { title: 'Likely AI-generated', message: `Confidence: ${confidencePct}%\nReal: ${complement}%`, type: 'warning', ts: Date.now() } });
          } else if (result?.no_face) {
            chrome.storage?.local?.set({ lastToast: { title: 'Analysis complete', message: 'No face detected in the image', type: 'info', ts: Date.now() } });
          } else {
            chrome.storage?.local?.set({ lastToast: { title: 'Likely real', message: `Confidence: ${confidencePct}%\nAI: ${complement}%`, type: 'success', ts: Date.now() } });
          }
        } catch (_) {}
        sendResponse({ success: true, result });
      } catch (e) {
        console.error('classifyUrl failed:', e);
        try { chrome.storage?.local?.set({ lastToast: { title: 'Analysis error', message: String(e?.message || 'Classify URL failed'), type: 'error', ts: Date.now() } }); } catch (_) {}
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
