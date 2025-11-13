// content-main.js — Main content script for the image cropper
(() => {
  // Track if extension context is still valid
  let isExtensionContextValid = true;
  let clickToDetectEnabled = false;
  let lastClickTs = 0;
  
  // Helper function to safely send messages
  async function sendMessageSafely(message) {
    try {
      if (chrome.runtime?.id) {
        return await chrome.runtime.sendMessage(message);
      }
      throw new Error('Extension context is no longer valid');
    } catch (err) {
      if (err.message.includes('Extension context invalidated') || 
          err.message.includes('Could not establish connection')) {
        isExtensionContextValid = false;
        throw new Error('Extension was reloaded. Please refresh the page and try again.');
      }
      throw err;
    }
  }

  // Removed legacy cropping message handlers; we now use direct click-to-detect only

  // Load setting for click-to-detect
  try {
    chrome.storage?.sync?.get({ clickToDetect: false }, (items) => {
      clickToDetectEnabled = !!items.clickToDetect;
    });
  } catch (_) {}

  

  // React to settings updates (update flag only)
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'settingsUpdated' && msg.settings && typeof msg.settings.clickToDetect !== 'undefined') {
        clickToDetectEnabled = !!msg.settings.clickToDetect;
      }
    });
  } catch (_) {}

  // Removed legacy cropping overlay; direct click-to-detect is used instead

  console.log("Content script (main) loaded");
  
  // Choose the best available URL for an <img>, preferring largest srcset candidate
  function getBestImageUrl(imgEl) {
    try {
      if (!imgEl) return null;
      const base = (imgEl.ownerDocument && imgEl.ownerDocument.baseURI) || document.baseURI || location.href;
      const toAbs = (u) => {
        try { return new URL(u, base).href; } catch (_) { return u; }
      };
      // If srcset available, pick largest width descriptor
      const srcset = imgEl.getAttribute('srcset');
      if (srcset) {
        const candidates = srcset.split(',').map(s => s.trim()).map(item => {
          const parts = item.split(' ');
          const url = parts[0];
          const w = parts.find(p => p.endsWith('w'));
          const width = w ? parseInt(w) : 0;
          return { url: toAbs(url), width };
        }).filter(c => !!c.url);
        if (candidates.length) {
          candidates.sort((a, b) => b.width - a.width);
          return candidates[0].url;
        }
      }
      // Fallback to currentSrc if available
      if (imgEl.currentSrc) return toAbs(imgEl.currentSrc);
      return imgEl.src ? toAbs(imgEl.src) : null;
    } catch (_) {
      return imgEl && (imgEl.currentSrc || imgEl.src) || null;
    }
  }

  // Global click-to-detect (Option B)
  document.addEventListener('click', async (e) => {
    try {
      if (!clickToDetectEnabled) return;
      const now = Date.now();
      if (now - lastClickTs < 800) return; // debounce
      lastClickTs = now;
      // Find an IMG from the event target
      let img = null;
      if (e.target && typeof e.target.closest === 'function') {
        img = e.target.closest('img');
      }
      if (!img && typeof e.composedPath === 'function') {
        const path = e.composedPath();
        img = path && path.find && path.find((n) => n && n.tagName === 'IMG');
      }
      if (!img || !(img instanceof HTMLImageElement)) return;
      // Skip too-small images / icons
      if (!img.src || img.naturalWidth < 80 || img.naturalHeight < 80) return; // skip tiny icons
      showToast('AI Image Guard', 'Analyzing image...', 'info');
      // Prefer classify by URL to avoid tainted canvas issues
      if (img.src.startsWith('http') || img.src.startsWith('https')) {
        const targetUrl = getBestImageUrl(img) || img.src;
        try {
          const resp = await sendMessageSafely({ action: 'classifyUrl', url: targetUrl, user_action: 'On-click detect', detection_type: 'On-click detect' });
          renderResultToast(resp && resp.result ? resp.result : resp);
          return;
        } catch (_) { /* fallback below */ }
      }
      // Fallback: draw to canvas if same-origin data available
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        ctx.drawImage(img, 0, 0);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
        const resp = await sendMessageSafely({ action: 'analyzeImage', imageData: dataUrl, source: 'click-to-detect', user_action: 'On-click detect', detection_type: 'On-click detect' });
        renderResultToast(resp && resp.result ? resp.result : resp);
      } catch (err) {
        // As a last resort, try classifyUrl even if non-http (may fail silently)
        try { 
          const resp = await sendMessageSafely({ action: 'classifyUrl', url: img.src, user_action: 'On-click detect', detection_type: 'On-click detect' });
          renderResultToast(resp && resp.result ? resp.result : resp);
        } catch (_) {}
      }
    } catch (_) {}
  }, true);

  function renderResultToast(payload) {
    try {
      if (!payload) { showToast('Analysis error', 'No response', 'error'); return; }
      // Server responses differ: direct success {status,is_fake,confidence} or {status,result:{...}}
      const p = payload.result ? payload.result : payload;
      if (p.status === 'error' || payload.status === 'error') {
        showToast('Analysis error', (p.message || payload.message || 'Failed'), 'error');
        return;
      }
      // Direct model path
      if (typeof p.is_fake === 'boolean' && typeof p.confidence !== 'undefined') {
        const confPct = Math.round((p.confidence || 0) * 100);
        const complement = Math.max(0, 100 - confPct);
        const label = p.is_fake ? 'Likely AI-generated' : 'Likely real';
        const extra = p.is_fake ? `Real: ${complement}%` : `AI: ${complement}%`;
        showToast('Detection Result', `${label}\nConfidence: ${confPct}%\n${extra}`, p.is_fake ? 'warning' : 'success');
        return;
      }
      // Ensemble path
      if (p.final_decision) {
        const fd = p.final_decision;
        showToast('Detection Result', `${fd.final_label}\nReal: ${fd.real_confidence}% | Fake: ${fd.fake_confidence}%`, 'info');
        return;
      }
      showToast('Analysis complete', 'Unknown response format', 'info');
    } catch (e) {
      showToast('Analysis error', String(e), 'error');
    }
  }
  
  // Lightweight toast system and listener so background can show results anywhere
  function showToast(title, message, type = 'info') {
    try {
      let container = document.getElementById('deepfake-toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'deepfake-toast-container';
        Object.assign(container.style, { position:'fixed', top:'16px', right:'16px', display:'flex', flexDirection:'column', gap:'10px', zIndex:'2147483647' });
        document.body.appendChild(container);
      }
      while (container.firstChild) container.removeChild(container.firstChild);
      const variants = { info:['#0ea5e9','#0b1220','#e5f6ff'], success:['#22c55e','#0c1a14','#eafff1'], warning:['#f59e0b','#1a150b','#fff7e6'], error:['#ef4444','#1a0b0b','#ffecec'] };
      const v = variants[type] || variants.info;
      const toast = document.createElement('div');
      toast.style.cssText = `display:flex;align-items:start;gap:12px;padding:12px 14px;max-width:360px;background:${v[1]};color:${v[2]};border-left:4px solid ${v[0]};border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,0.35);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;`;
      const content = document.createElement('div');
      const t = document.createElement('div'); t.textContent = title || 'AI Image Guard'; t.style.cssText = 'font-weight:600;letter-spacing:.2px;margin-bottom:2px;';
      const m = document.createElement('div'); m.textContent = message || ''; m.style.cssText = 'opacity:.9;line-height:1.35;white-space:pre-line;';
      content.appendChild(t); content.appendChild(m);
      const closeBtn = document.createElement('button'); closeBtn.textContent = '✕'; closeBtn.setAttribute('aria-label','Close notification'); closeBtn.style.cssText = 'margin-left:auto;background:transparent;border:none;color:inherit;cursor:pointer;font-size:14px;padding:2px;opacity:.7;';
      closeBtn.onclick = () => { if (toast.parentNode) toast.parentNode.removeChild(toast); };
      toast.appendChild(content); toast.appendChild(closeBtn); container.appendChild(toast);
      setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 5000);
    } catch (_) {}
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.action === 'showToast') {
        showToast(msg.title, msg.message, msg.type || 'info');
      }
    });
  } catch (_) {}

  // No persistent panel hydration after revert
})();
