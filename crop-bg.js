// ======================================================
// background.js — Enhanced (Aligned with Option 1 Server Logic)
// ======================================================

// Centralized server URL loader (local to this module)
let SERVER_URL_CACHE = 'http://127.0.0.1:8000';
function getServerUrl() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ serverUrl: SERVER_URL_CACHE }, (items) => {
      SERVER_URL_CACHE = items?.serverUrl || SERVER_URL_CACHE;
      resolve(SERVER_URL_CACHE);
    });
  });
}
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
    await fetch(`${serverUrl || SERVER_URL_CACHE}/log_event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec) });
  } catch (_) {}
}

// (removed) mapDisplayPercent unused after simplification

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'settingsUpdated' && msg.settings?.serverUrl) {
    SERVER_URL_CACHE = msg.settings.serverUrl;
  }
});

// Create right-click context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "detectImage",
    title: "Detect Image",
    contexts: ["image"]
  });
  console.log("✅ Context menu created: Detect Image");
});

// Helpers
// Disable OS notifications; we only use in-page toasts now
function showNotification(icon, title, message) {
  // no-op
}

// Send an in-page toast to the content script (preferred for FB)
function sendToast(tabId, title, message, type = 'info') {
  try {
    if (tabId && chrome.tabs && chrome.tabs.sendMessage) {
      chrome.tabs.sendMessage(tabId, { action: 'showToast', title, message, type }, () => {
        // intentionally ignore errors to avoid triggering OS notifications
        void 0;
      });
    }
  } catch (e) {
    // swallow
  }
}

// (removed) client-side resize not used in right-click flow

// Handle context menu click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "detectImage" && info.srcUrl) {
    console.log("🔎 Detecting full image:", info.srcUrl);
    sendToast(tab && tab.id, "AI Image Guard", "Analyzing image", 'info');

    (async () => {
      try {
        const __tCap = Date.now() / 1000;
        let __tReq = null;
        let __tResp = null;
        const serverUrl = await getServerUrl();

        // Try to fetch image bytes first for consistent content
        let data;
        try {
          const imgResp = await Promise.race([
            fetch(info.srcUrl, { mode: 'cors' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Image fetch timed out.")), 8000))
          ]);
          if (!imgResp.ok) throw new Error(`Image fetch ${imgResp.status}`);
          const blob = await imgResp.blob();
          if (!blob || (blob.size !== undefined && blob.size === 0)) throw new Error('Empty image blob');

          const formData = new FormData();
          formData.append('file', new File([blob], 'context-image.jpg', { type: blob.type || 'image/jpeg' }));

          __tReq = Date.now() / 1000;
          const resp = await Promise.race([
            fetch(`${serverUrl}/classify/file`, { method: "POST", body: formData }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timed out.")), 8000))
          ]);
          if (!resp.ok) throw new Error("Deepfake detection request failed.");
          data = await resp.json();
          __tResp = Date.now() / 1000;
        } catch (e) {
          // Fallback to server URL path
          __tReq = Date.now() / 1000;
          const response = await Promise.race([
            fetch(`${serverUrl}/classify/url`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: info.srcUrl })
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timed out.")), 8000))
          ]);
          if (!response.ok) throw new Error("Deepfake detection request failed.");
          data = await response.json();
          __tResp = Date.now() / 1000;
        }

        if (data && data.status === 'success' && typeof data.is_fake === 'boolean') {
          const confPct = Math.round((data.confidence || 0) * 100);
          const complement = Math.max(0, 100 - confPct);
          const title = 'Analysis Complete';
          const msg = data.is_fake
            ? `Likely AI-generated\nConfidence: ${confPct}%\nReal: ${complement}%`
            : `Likely real\nConfidence: ${confPct}%\nAI: ${complement}%`;
          sendToast(tab && tab.id, title, msg, data.is_fake ? 'warning' : 'success');
          const __tNotif = Date.now() / 1000;
          const predicted = data.is_fake ? 'FAKE' : 'REAL';
          logDetection({
            image_id: 'img-' + (await hashString(info.srcUrl || '')),
            image_source: info.srcUrl,
            predicted_label: predicted,
            confidence_score: Number(data.confidence) || null,
            api_status: 'success',
            user_action: 'Right-click detection',
            detection_type: 'Right-click detection',
            pipeline_timings: { capture_start: __tCap, api_request_start: __tReq, api_response_end: __tResp, notification_sent: __tNotif }
          }, serverUrl);
        } else if (data && data.final_decision) {
          const { final_label, real_confidence, fake_confidence } = data.final_decision;
          const title = 'Analysis Complete';
          const msg = `${final_label}\nReal: ${real_confidence}% | Fake: ${fake_confidence}%`;
          sendToast(tab && tab.id, title, msg, 'info');
          const __tNotif = Date.now() / 1000;
          const labelUp = String(final_label || '').toLowerCase();
          const predicted = labelUp.includes('real') ? 'REAL' : (labelUp.includes('fake') ? 'FAKE' : 'UNKNOWN');
          const confPct = predicted === 'REAL' ? Number(real_confidence) : Number(fake_confidence);
          logDetection({
            image_id: 'img-' + (await hashString(info.srcUrl || '')),
            image_source: info.srcUrl,
            predicted_label: predicted,
            confidence_score: isFinite(confPct) ? (confPct / 100) : null,
            api_status: 'success',
            user_action: 'Right-click detection',
            detection_type: 'Right-click detection',
            pipeline_timings: { capture_start: __tCap, api_request_start: __tReq, api_response_end: __tResp, notification_sent: __tNotif }
          }, serverUrl);
        } else if (data && data.error) {
          sendToast(tab && tab.id, "Analysis Error", String(data.error), 'error');
          const __tNotif = Date.now() / 1000;
          logDetection({
            image_id: 'img-' + (await hashString(info.srcUrl || '')),
            image_source: info.srcUrl,
            predicted_label: null,
            confidence_score: null,
            api_status: 'error',
            error_message: String(data.error || 'Unknown error'),
            user_action: 'Right-click detection',
            detection_type: 'Right-click detection',
            pipeline_timings: { capture_start: __tCap, api_request_start: __tReq, api_response_end: __tResp, notification_sent: __tNotif }
          }, serverUrl);
        } else {
          sendToast(tab && tab.id, "Analysis Error", "Unexpected server response", 'error');
          const __tNotif = Date.now() / 1000;
          logDetection({
            image_id: 'img-' + (await hashString(info.srcUrl || '')),
            image_source: info.srcUrl,
            predicted_label: null,
            confidence_score: null,
            api_status: 'error',
            error_message: 'Unexpected server response',
            user_action: 'Right-click detection',
            detection_type: 'Right-click detection',
            pipeline_timings: { capture_start: __tCap, api_request_start: __tReq, api_response_end: __tResp, notification_sent: __tNotif }
          }, serverUrl);
        }
      } catch (error) {
        console.error("❌ Error in full-image detection:", error);
        sendToast(tab && tab.id, "Analysis Error", error.message || 'Unknown error', 'error');
        try {
          const serverUrl = await getServerUrl();
          const now = Date.now() / 1000;
          logDetection({
            image_id: 'img-' + (await hashString(info.srcUrl || '')),
            image_source: info.srcUrl,
            predicted_label: null,
            confidence_score: null,
            api_status: 'error',
            error_message: String(error?.message || 'Unknown error'),
            user_action: 'Right-click detection',
            detection_type: 'Right-click detection',
            pipeline_timings: { capture_start: now, api_request_start: now, api_response_end: now, notification_sent: now }
          }, serverUrl);
        } catch (_) {}
      }
    })();
  }
});

// (removed) croppedImageReady flow no longer supported