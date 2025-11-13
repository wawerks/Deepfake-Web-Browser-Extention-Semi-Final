// background.js â€” Main background script that imports and initializes other background scripts

// Import the background scripts
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
let SESSION_ID = null;
function getEnvInfo() {
  const ua = (self && self.navigator && navigator.userAgent) || '';
  let os = 'unknown';
  if (/Windows/i.test(ua)) os = 'Windows'; else if (/Mac OS X/i.test(ua)) os = 'macOS'; else if (/Linux/i.test(ua)) os = 'Linux'; else if (/Android/i.test(ua)) os = 'Android'; else if (/iPhone|iPad|iOS/i.test(ua)) os = 'iOS';
  let browser = 'Chrome';
  if (/Edg\//.test(ua)) browser = 'Edge'; else if (/Firefox\//.test(ua)) browser = 'Firefox';
  return { browser, os, user_agent: ua, device_model: null, network_type: 'unknown' };
}
function getSessionId() {
  if (SESSION_ID) return Promise.resolve(SESSION_ID);
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ sessionId: null }, (items) => {
        if (items && items.sessionId) {
          SESSION_ID = items.sessionId;
          resolve(SESSION_ID);
        } else {
          const id = 'sess-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
          chrome.storage.local.set({ sessionId: id }, () => { SESSION_ID = id; resolve(id); });
        }
      });
    } catch (_) {
      const id = 'sess-' + Math.random().toString(36).slice(2);
      SESSION_ID = id;
      resolve(id);
    }
  });
}
async function hashString(s) {
  const enc = new TextEncoder();
  const buf = enc.encode(String(s || ''));
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const arr = Array.from(new Uint8Array(hash));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
async function logDetection(payload, serverUrl) {
  try {
    const env = getEnvInfo();
    const rec = {
      timestamp: new Date().toISOString(),
      session_id: await getSessionId(),
      image_id: payload.image_id || ('img-' + Math.random().toString(36).slice(2)),
      image_source: payload.image_source || null,
      ground_truth_label: null,
      predicted_label: payload.predicted_label || null,
      confidence_score: typeof payload.confidence_score === 'number' ? Math.max(0, Math.min(1, payload.confidence_score)) : null,
      pipeline_timings: payload.pipeline_timings || null,
      api_status: payload.api_status || 'unknown',
      error_message: payload.error_message || null,
      user_action: payload.user_action || null,
      detection_type: payload.detection_type || null,
      browser: env.browser,
      os: env.os,
      network_type: env.network_type,
      device_model: env.device_model,
      user_agent: env.user_agent,
    };
    const pt = payload.pipeline_timings || {};
    const apiLat = (isFinite(pt.api_response_end) && isFinite(pt.api_request_start)) ? Math.round((pt.api_response_end - pt.api_request_start) * 1000) : null;
    const totalLat = (isFinite(pt.notification_sent) && isFinite(pt.capture_start)) ? Math.round((pt.notification_sent - pt.capture_start) * 1000) : null;
    rec.client_api_latency_ms = apiLat;
    rec.client_total_latency_ms = totalLat;
    rec.inference_time_ms = apiLat;
    await fetch(`${serverUrl || SERVER_URL}/log_event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec) });
  } catch (_) {}
}

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
      let __tCap = Date.now() / 1000;
      let __tReq = null, __tResp = null, __tNotif = null;
      let __imgId = null;
      const actionLabel = (request && (request.detection_type || request.user_action)) || 'On-click detect';
      try {
        try { chrome.storage?.local?.set({ lastToast: { title: 'AI Image Guard', message: 'Analyzing image', type: 'info', ts: Date.now() } }); } catch (_) {}
        const blob = dataURLToBlob(request.imageData);
        __imgId = 'img-' + (await hashString(request.imageData || ''));
        const formData = new FormData();
        formData.append('file', new File([blob], 'upload.jpg', { type: blob.type || 'image/jpeg' }));

        __tReq = Date.now() / 1000;
        const resp = await fetch(`${SERVER_URL}/classify/file`, {
          method: 'POST',
          body: formData
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new Error(`Server ${resp.status} ${resp.statusText} ${text}`);
        }

        const result = await resp.json();
        __tResp = Date.now() / 1000;
        const confVal = Number(result?.confidence);
        if (!isFinite(confVal) || confVal <= 0 || result?.error) {
          try { chrome.storage?.local?.set({ lastToast: { title: 'Analysis unavailable', message: String(result?.error || 'Service limit reached or invalid response'), type: 'error', ts: Date.now() } }); __tNotif = Date.now() / 1000; } catch (_) {}
          logDetection({ image_id: __imgId, image_source: 'dataurl', predicted_label: null, confidence_score: Number(result?.confidence) || null, api_status: 'error', error_message: String(result?.error || 'Invalid result'), user_action: actionLabel, detection_type: actionLabel, pipeline_timings: { capture_start: __tCap, api_request_start: __tReq, api_response_end: __tResp, notification_sent: __tNotif } });
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
          __tNotif = Date.now() / 1000;
        } catch (_) {}
        logDetection({ image_id: __imgId, image_source: 'dataurl', predicted_label: (result?.no_face ? 'NO_FACE' : (result?.is_fake ? 'FAKE' : 'REAL')), confidence_score: Number(result?.confidence) || null, api_status: 'success', error_message: null, user_action: actionLabel, detection_type: actionLabel, pipeline_timings: { capture_start: __tCap, api_request_start: __tReq, api_response_end: __tResp, notification_sent: __tNotif } });
        sendResponse({ success: true, result });
      } catch (e) {
        console.error('analyzeImage failed:', e);
        try { chrome.storage?.local?.set({ lastToast: { title: 'Analysis error', message: String(e?.message || 'Analyze failed'), type: 'error', ts: Date.now() } }); __tNotif = Date.now() / 1000; } catch (_) {}
        __tResp = __tResp || Date.now() / 1000;
        logDetection({ image_id: __imgId || ('img-' + Math.random().toString(36).slice(2)), image_source: 'dataurl', predicted_label: null, confidence_score: null, api_status: 'error', error_message: String(e?.message || 'Analyze failed'), user_action: actionLabel, detection_type: actionLabel, pipeline_timings: { capture_start: __tCap, api_request_start: __tReq, api_response_end: __tResp, notification_sent: __tNotif } });
        sendResponse({ success: false, error: e.message || 'Analyze failed' });
      }
    })();
    return true; // async
  }

  if (request.action === 'classifyUrl' && request.url) {
    (async () => {
      let __tCap = Date.now() / 1000;
      let __tReq = null, __tResp = null, __tNotif = null;
      let __imgId = 'img-' + (await hashString(request.url || ''));
      const actionLabel = (request && (request.detection_type || request.user_action)) || 'On-click detect';
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
          __tReq = Date.now() / 1000;
          const resp = await fetch(`${SERVER_URL}/classify/file`, {
            method: 'POST',
            body: formData
          });
          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`Server ${resp.status} ${resp.statusText} ${text}`);
          }
          const result = await resp.json();
          __tResp = Date.now() / 1000;
          const confVal = Number(result?.confidence);
          if (!isFinite(confVal) || confVal <= 0 || result?.error) {
            try { chrome.storage?.local?.set({ lastToast: { title: 'Analysis unavailable', message: String(result?.error || 'Service limit reached or invalid response'), type: 'error', ts: Date.now() } }); __tNotif = Date.now() / 1000; } catch (_) {}
            logDetection({ image_id: __imgId, image_source: request.url, predicted_label: null, confidence_score: Number(result?.confidence) || null, api_status: 'error', error_message: String(result?.error || 'Invalid result'), user_action: actionLabel, detection_type: actionLabel, pipeline_timings: { capture_start: __tCap, api_request_start: __tReq, api_response_end: __tResp, notification_sent: __tNotif } });
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
            __tNotif = Date.now() / 1000;
          } catch (_) {}
          logDetection({ image_id: __imgId, image_source: request.url, predicted_label: (result?.no_face ? 'NO_FACE' : (result?.is_fake ? 'FAKE' : 'REAL')), confidence_score: Number(result?.confidence) || null, api_status: 'success', error_message: null, user_action: actionLabel, detection_type: actionLabel, pipeline_timings: { capture_start: __tCap, api_request_start: __tReq, api_response_end: __tResp, notification_sent: __tNotif } });
          sendResponse({ success: true, result });
          return;
        }

        __tReq = Date.now() / 1000;
        const resp = await fetch(`${SERVER_URL}/classify/url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: request.url })
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new Error(`Server ${resp.status} ${resp.statusText} ${text}`);
        }
        const result = await resp.json();
        __tResp = Date.now() / 1000;
        const confVal = Number(result?.confidence);
        if (!isFinite(confVal) || confVal <= 0 || result?.error) {
          try { chrome.storage?.local?.set({ lastToast: { title: 'Analysis unavailable', message: String(result?.error || 'Service limit reached or invalid response'), type: 'error', ts: Date.now() } }); __tNotif = Date.now() / 1000; } catch (_) {}
          logDetection({ image_id: __imgId, image_source: request.url, predicted_label: null, confidence_score: Number(result?.confidence) || null, api_status: 'error', error_message: String(result?.error || 'Invalid result'), user_action: request.user_action || 'On-click detect', detection_type: request.detection_type || 'On-click detect', pipeline_timings: { capture_start: __tCap, api_request_start: __tReq, api_response_end: __tResp, notification_sent: __tNotif } });
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
          __tNotif = Date.now() / 1000;
        } catch (_) {}
        logDetection({ image_id: __imgId, image_source: request.url, predicted_label: (result?.no_face ? 'NO_FACE' : (result?.is_fake ? 'FAKE' : 'REAL')), confidence_score: Number(result?.confidence) || null, api_status: 'success', error_message: null, user_action: actionLabel, detection_type: actionLabel, pipeline_timings: { capture_start: __tCap, api_request_start: __tReq, api_response_end: __tResp, notification_sent: __tNotif } });
        sendResponse({ success: true, result });
      } catch (e) {
        console.error('classifyUrl failed:', e);
        try { chrome.storage?.local?.set({ lastToast: { title: 'Analysis error', message: String(e?.message || 'Classify URL failed'), type: 'error', ts: Date.now() } }); __tNotif = Date.now() / 1000; } catch (_) {}
        __tResp = __tResp || Date.now() / 1000;
        logDetection({ image_id: __imgId, image_source: request.url, predicted_label: null, confidence_score: null, api_status: 'error', error_message: String(e?.message || 'Classify URL failed'), user_action: actionLabel, detection_type: actionLabel, pipeline_timings: { capture_start: __tCap, api_request_start: __tReq, api_response_end: __tResp, notification_sent: __tNotif } });
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

