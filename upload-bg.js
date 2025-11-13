// Cache for storing detection results
const detectionCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

let SERVER_URL_CACHE = 'http://127.0.0.1:8000';
function getServerUrl() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get({ serverUrl: SERVER_URL_CACHE }, (items) => {
        SERVER_URL_CACHE = items?.serverUrl || SERVER_URL_CACHE;
        resolve(SERVER_URL_CACHE);
      });
    } catch (_) { resolve(SERVER_URL_CACHE); }
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
          SESSION_ID = items.sessionId; resolve(SESSION_ID);
        } else {
          const id = 'sess-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
          chrome.storage.local.set({ sessionId: id }, () => { SESSION_ID = id; resolve(id); });
        }
      });
    } catch (_) {
      const id = 'sess-' + Math.random().toString(36).slice(2);
      SESSION_ID = id; resolve(id);
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

// Handle messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'DETECT_DEEPFAKE') {
    console.log('Received DETECT_DEEPFAKE request', { 
      hasImageData: !!request.imageData,
      type: typeof request.imageData,
      isUpload: request.isUpload || false
    });
    
    detectDeepfake(request.imageData, request.mimeType)
      .then(result => {
        console.log('Sending success response');
        sendResponse({ success: true, result });
      })
      .catch(error => {
        console.error('Error in detectDeepfake:', error);
        sendResponse({ 
          success: false, 
          error: error.message || 'Unknown error occurred' 
        });
      });
    
    return true; // Required for async response
  }
  return false;
});

// Detect deepfake using the API
async function detectDeepfake(imageData, mimeType = 'image/jpeg') {
  try {
    const __tCap = Date.now() / 1000;
    // Generate cache key from the image data
    const cacheKey = await generateHash(imageData);
    const cached = detectionCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      try {
        const serverUrl = await getServerUrl();
        const now = Date.now() / 1000;
        await logDetection({
          image_id: 'img-' + String(cacheKey || '').slice(0, 16),
          image_source: 'upload',
          predicted_label: cached.result && typeof cached.result.is_fake === 'boolean' ? (cached.result.is_fake ? 'FAKE' : 'REAL') : null,
          confidence_score: (cached.result && typeof cached.result.confidence === 'number') ? cached.result.confidence : null,
          api_status: 'success',
          user_action: 'Upload interception',
          detection_type: 'Upload interception',
          pipeline_timings: { capture_start: __tCap, api_request_start: now, api_response_end: now, notification_sent: now }
        }, serverUrl);
      } catch (_) {}
      return cached.result;
    }

    // Ensure we have valid image data
    if (!imageData) {
      throw new Error('No image data provided');
    }

    let blob;
    
    // Handle base64 string
    if (typeof imageData === 'string') {
      // Convert base64 to binary
      const binaryString = atob(imageData);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      blob = new Blob([bytes], { type: mimeType });
    } 
    // Handle Blob
    else if (imageData instanceof Blob) {
      blob = imageData;
    } 
    // Handle ArrayBuffer or ArrayBufferView
    else if (imageData instanceof ArrayBuffer || ArrayBuffer.isView(imageData)) {
      blob = new Blob([imageData], { type: mimeType });
    } else {
      throw new Error('Unsupported image data format');
    }

    const formData = new FormData();
    formData.append('file', blob, 'image.jpg');

    console.log('Sending image to detection API...');
    const serverUrl = await getServerUrl();
    const __tReq = Date.now() / 1000;
    const response = await fetch(`${serverUrl}/classify/file`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('API Error:', { status: response.status, statusText: response.statusText, error });
      throw new Error(`API Error: ${response.status} ${response.statusText} - ${error}`);
    }

    const result = await response.json();
    const __tResp = Date.now() / 1000;
    console.log('Detection result:', result);
    
    try {
      const predicted = (result && typeof result.is_fake === 'boolean') ? (result.is_fake ? 'FAKE' : 'REAL') : null;
      const conf = (result && typeof result.confidence === 'number') ? result.confidence : null;
      await logDetection({
        image_id: 'img-' + String(cacheKey || '').slice(0, 16),
        image_source: 'upload',
        predicted_label: predicted,
        confidence_score: conf,
        api_status: (result && result.status) || 'success',
        user_action: 'Upload interception',
        detection_type: 'Upload interception',
        pipeline_timings: { capture_start: __tCap, api_request_start: __tReq, api_response_end: __tResp, notification_sent: __tResp }
      }, serverUrl);
    } catch (_) {}

    // Cache the result if we have a valid cache key
    if (cacheKey) {
      detectionCache.set(cacheKey, {
        result,
        timestamp: Date.now()
      });
    }

    return result;
  } catch (error) {
    console.error('Deepfake detection failed:', error);
    try {
      const serverUrl = await getServerUrl();
      const now = Date.now() / 1000;
      await logDetection({
        image_id: 'img-' + (await hashString(String(Math.random()))),
        image_source: 'upload',
        predicted_label: null,
        confidence_score: null,
        api_status: 'error',
        error_message: String(error?.message || 'Unknown error'),
        user_action: 'Upload interception',
        detection_type: 'Upload interception',
        pipeline_timings: { capture_start: now, api_request_start: now, api_response_end: now, notification_sent: now }
      }, serverUrl);
    } catch (_) {}
    throw error;
  }
}

// Generate hash for cache key
async function generateHash(data) {
  try {
    // Ensure data is an ArrayBuffer or ArrayBufferView
    let buffer;
    if (data instanceof ArrayBuffer) {
      buffer = data;
    } else if (ArrayBuffer.isView(data)) {
      buffer = data.buffer;
    } else if (data instanceof Blob) {
      buffer = await data.arrayBuffer();
    } else {
      // Convert to string and then to ArrayBuffer
      const encoder = new TextEncoder();
      buffer = encoder.encode(JSON.stringify(data)).buffer;
    }

    // Generate hash
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    console.error('Error generating hash:', error);
    // Fallback to a simple string hash if crypto.subtle is not available
    const str = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString();
  }
}