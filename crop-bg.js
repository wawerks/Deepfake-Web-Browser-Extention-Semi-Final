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

// Map API percentage to display percentage per requirement
function mapDisplayPercent(rawPct) {
  const v = Math.round(Number(rawPct) || 0);
  if (v >= 1 && v <= 20) return 79 + v; // 1..20 -> 80..99
  return v; // 0 or >=20 unchanged
}

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

// Resize image blob on client to speed up upload/inference
async function resizeImageBlob(blob, maxEdge = 512) {
  try {
    const bmp = await createImageBitmap(blob);
    const maxDim = Math.max(bmp.width, bmp.height);
    if (maxDim <= maxEdge) {
      bmp.close();
      return blob; // no resize needed
    }
    const scale = maxEdge / maxDim;
    const width = Math.round(bmp.width * scale);
    const height = Math.round(bmp.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, width, height);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    bmp.close();
    return out;
  } catch (e) {
    // Fallback: return original blob if any step fails
    return blob;
  }
}

// Handle context menu click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "detectImage" && info.srcUrl) {
    console.log("🔎 Detecting full image:", info.srcUrl);
    sendToast(tab && tab.id, "AI Image Guard", "Analyzing image", 'info');

    (async () => {
      try {
        const serverUrl = await getServerUrl();

        const response = await Promise.race([
          fetch(`${serverUrl}/classify/url`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: info.srcUrl, use_vit: true, use_efficientnet: true })
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timed out.")), 8000))
        ]);

        if (!response.ok) throw new Error("Deepfake detection request failed.");

        const data = await response.json();

        if (data && data.status === 'success' && typeof data.is_fake === 'boolean') {
          const confPctRaw = Math.round((data.confidence || 0) * 100);
          const confPct = mapDisplayPercent(confPctRaw);
          const title = 'Analysis Complete';
          const msg = data.is_fake
            ? `Likely AI-generated\nConfidence: ${confPct}%`
            : `Likely real\nConfidence: ${confPct}%`;
          sendToast(tab && tab.id, title, msg, data.is_fake ? 'warning' : 'success');
        } else if (data && data.final_decision) {
          const { final_label, real_confidence, fake_confidence } = data.final_decision;
          const title = 'Analysis Complete';
          const realPct = mapDisplayPercent(Number(real_confidence) || 0);
          const fakePct = mapDisplayPercent(Number(fake_confidence) || 0);
          const msg = `${final_label}\nReal: ${realPct}% | Fake: ${fakePct}%`;
          sendToast(tab && tab.id, title, msg, 'info');
        } else if (data && data.error) {
          sendToast(tab && tab.id, "Analysis Error", String(data.error), 'error');
        } else {
          sendToast(tab && tab.id, "Analysis Error", "Unexpected server response", 'error');
        }
      } catch (error) {
        console.error("❌ Error in full-image detection:", error);
        sendToast(tab && tab.id, "Analysis Error", error.message || 'Unknown error', 'error');
      }
    })();
  }
});

// Listen for cropped image data from content.js
chrome.runtime.onMessage.addListener(async (message, sender) => {
  if (message.action !== "croppedImageReady") return;

  console.log("📤 Received cropped image data, preparing to send to backend...");
  const tabId = sender && sender.tab && sender.tab.id;
  sendToast(tabId, "AI Image Guard", "Analyzing image", 'info');

  try {
    let blob = message.imageBlob;

    // Decode if necessary
    if (!blob && message.buffer) {
      const uint8 = new Uint8Array(message.buffer);
      blob = new Blob([uint8], { type: message.type || "image/jpeg" });
    }
    if (!blob && message.dataUrl) {
      const [meta, base64] = message.dataUrl.split(",");
      const mimeMatch = /data:([^;]+);base64/.exec(meta);
      const mime = (mimeMatch && mimeMatch[1]) || "image/jpeg";
      const binary = atob(base64);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes], { type: mime });
    }

    if (!blob || (blob.size !== undefined && blob.size === 0)) {
      throw new Error("Received empty image blob after decoding.");
    }

    // Keep original for face detection; use resized for classification
    const originalBlob = blob;
    const classifyBlob = await resizeImageBlob(blob, 512);

    const serverUrl = await getServerUrl();

    // Face Detection (blocking). If none, stop and inform user.
    const faceForm = new FormData();
    faceForm.append("file", new File([originalBlob], "face_check.jpg", { type: originalBlob.type || "image/jpeg" }));
    const faceResp = await fetch(`${serverUrl}/detect-face`, { method: "POST", body: faceForm });
    if (!faceResp.ok) throw new Error("Face detection request failed.");
    const faceData = await faceResp.json();
    const hasFace = !!(faceData.has_face || (typeof faceData.face_count === 'number' && faceData.face_count > 0));
    if (!hasFace) {
      sendToast(tabId, "AI Image Detector", "❌ No human face detected in crop. Please try a larger crop around the face.", 'warning');
      return;
    }

    // Deepfake Detection (only if face found)
    const formData = new FormData();
    formData.append("file", new File([classifyBlob], "cropped_face.jpg", { type: classifyBlob.type || "image/jpeg" }));

    const response = await Promise.race([
      fetch(`${serverUrl}/classify/file`, { method: "POST", body: formData }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timed out.")), 8000))
    ]);

    if (!response.ok) throw new Error("Deepfake detection request failed.");

    const data = await response.json();

    // Handle server response
    if (data && data.status === 'success' && typeof data.is_fake === 'boolean') {
      const confPct = Math.round((data.confidence || 0) * 100);
      const emoji = data.is_fake ? '❌' : '✅';
      const label = data.is_fake ? 'Likely AI-generated' : 'Likely real';
      const msg = `${emoji} ${label}\nConfidence: ${confPct}%`;
      sendToast(tabId, "Detection Result", msg, data.is_fake ? 'warning' : 'success');
    } else if (data && data.final_decision) {
      // Backward compatibility in case another server format is used
      const { final_label, real_confidence, fake_confidence } = data.final_decision;
      let emoji = "❌";
      if (final_label && final_label.toLowerCase().includes("real")) emoji = "✅";
      else if (final_label && final_label.toLowerCase().includes("uncertain")) emoji = "⚠️";
      const msg = `${emoji} ${final_label}\nReal: ${real_confidence}% | Fake: ${fake_confidence}%`;
      sendToast(tabId, "Detection Result", msg, 'info');
    } else if (data && data.error) {
      sendToast(tabId, "AI Image Detector", "Error: " + data.error, 'error');
    } else {
      sendToast(tabId, "AI Image Detector", "Unexpected server response.", 'error');
    }
  } catch (error) {
    console.error("❌ Error in background.js:", error);
    sendToast(tabId, "AI Image Detector", "Error: " + error.message, 'error');
  }
});