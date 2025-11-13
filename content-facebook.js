// content-facebook.js — Facebook-specific content script
(() => {
  'use strict';

  // Dynamic settings loaded from storage
  let SETTINGS = {
    realTimeScanning: true,
    scanInterval: 3,
    showNotifications: true,
    clickToDetect: false
  };
  let pageScanEnabled = false;
  let pageScanObserver = null;
  let pageScanIntervalId = null;

  // Configuration
  const CONFIG = {
    // Detection thresholds
    DETECTION_THRESHOLD: 0.7, // 70% confidence threshold
    NOTIFICATION_DURATION: 5000, // 5 seconds
    MAX_IMAGE_SIZE: 5 * 1024 * 1024, // 5MB
    
    // Facebook-specific selectors
    SELECTORS: {
      UPLOAD_INPUT: 'input[type="file"][accept*="image"], input[type="file"]:not([accept])',
      PREVIEW_CONTAINER: 'div[role="dialog"]',
      IMAGE_PREVIEW: 'img[src^="blob:"], img[src^="data:image/"]',
      POST_BUTTON: 'div[aria-label="Post"][role="button"]',
      STORY_BUTTON: 'div[aria-label="Add to your story"]',
      COMMENT_INPUT: 'div[role="textbox"][contenteditable="true"]',
      MESSAGE_INPUT: 'div[role="textbox"][contenteditable="true"]',
      PROFILE_PHOTO_UPLOAD: 'input[type="file"][accept*="image"]'
    },
    
    // Badge styles
    BADGE_STYLES: {
      position: 'absolute',
      padding: '4px 8px',
      borderRadius: '4px',
      color: 'white',
      fontSize: '12px',
      fontWeight: 'bold',
      zIndex: '9999',
      pointerEvents: 'none',
      textAlign: 'center',
      minWidth: '80px',
      opacity: '0.9',
      transition: 'opacity 0.3s',
      boxShadow: '0 2px 4px rgba(0,0,0,0.3)'
    },
    
    // Notification styles
    NOTIFICATION_STYLES: {
      position: 'fixed',
      top: '20px',
      right: '20px',
      padding: '12px 16px',
      borderRadius: '8px',
      color: 'white',
      zIndex: '2147483647',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      maxWidth: '320px',
      animation: 'fadeIn 0.3s ease-out'
    },
    
    // Status colors
    COLORS: {
      success: '#4CAF50',
      warning: '#FFC107',
      error: '#F44336',
      info: '#2196F3',
      default: '#757575'
    }
  };

  // Disable in-page badges to avoid duplicates; keep toasts enabled for results
  const SHOW_BADGES = false;
  const SHOW_TOASTS = true;

  // Map raw percentage to display percentage: if <=20, display = 100 - raw; else unchanged
  function mapDisplayPercent(rawPct) {
    const v = Math.round(Number(rawPct) || 0);
    if (v <= 20) return Math.max(0, Math.min(100, 100 - v));
    return v;
  }

  // Track processed elements to avoid duplicates
  const processedElements = new WeakSet();
  let isProcessingUpload = false;
  let currentToast = null;
  let currentToastTimer = null;
  let currentToastData = null;
  const CLIENT_ID = Math.random().toString(36).slice(2);
  let isApplyingStorageToast = false;

  // Initialize the scanner when the page is fully loaded
  async function initScanner() {
    if (!isFacebookPage()) return;
    
    console.log('[Facebook Scanner] Initializing...');
    // Load settings once at start
    try {
      await new Promise((resolve) => {
        chrome.storage?.sync?.get({
          realTimeScanning: true,
          scanInterval: 3,
          clickToDetect: false,
        }, (items) => {
          SETTINGS.realTimeScanning = !!items.realTimeScanning;
          SETTINGS.scanInterval = Math.max(1, parseInt(items.scanInterval || 3));
          SETTINGS.clickToDetect = !!items.clickToDetect;
          resolve();
        });
      });
    } catch (_) {}

    // Apply scanning state
    setPageScanning(SETTINGS.realTimeScanning);
    
    // Listen for file uploads
    setupUploadListeners();
    
    console.log('[Facebook Scanner] Initialized');
  }

  function setPageScanning(enable) {
    if (enable === pageScanEnabled) return;
    pageScanEnabled = !!enable;
    if (pageScanEnabled) {
      // Start observer
      try {
        if (!pageScanObserver) {
          pageScanObserver = new MutationObserver(handleMutations);
        }
        pageScanObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['src']
        });
      } catch (_) {}
      // Initial scan and periodic rescans per settings
      try { scanForImages(); } catch (_) {}
      clearInterval(pageScanIntervalId);
      pageScanIntervalId = setInterval(() => {
        try { scanForImages(); } catch (_) {}
      }, Math.max(1000, (SETTINGS.scanInterval || 3) * 1000));
      console.log('[Facebook Scanner] Real-time scanning: ON');
    } else {
      try { pageScanObserver && pageScanObserver.disconnect(); } catch (_) {}
      pageScanObserver = pageScanObserver || null;
      clearInterval(pageScanIntervalId); pageScanIntervalId = null;
      console.log('[Facebook Scanner] Real-time scanning: OFF');
    }
  }

  // Check if current page is Facebook
  function isFacebookPage() {
    return window.location.hostname.includes('facebook.com') || 
           window.location.hostname.includes('fb.com');
  }

  // Handle DOM mutations
  function handleMutations(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        // Check for new nodes with images
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.matches && node.matches('img')) {
              processImage(node);
            } else if (node.querySelectorAll) {
              const images = node.querySelectorAll('img');
              images.forEach(processImage);
            }
          }
        }
      } else if (mutation.type === 'attributes' && 
                 mutation.attributeName === 'src' && 
                 mutation.target.tagName === 'IMG') {
        // Handle image source changes
        processImage(mutation.target);
      }
    }
  }

  // Scan for images on the page
  function scanForImages() {
    const images = document.querySelectorAll('img');
    images.forEach(processImage);
  }

  // Process an image element
  function processImage(img) {
    if (!isValidImage(img) || processedElements.has(img)) {
      return;
    }
    
    processedElements.add(img);
    
    // Add hover effect
    img.style.transition = 'opacity 0.3s';
    img.addEventListener('mouseenter', () => {
      img.style.opacity = '0.8';
    });
    img.addEventListener('mouseleave', () => {
      img.style.opacity = '1';
    });
    
    // Add click handler for analysis only if this script's click-to-detect is enabled
    if (SETTINGS.clickToDetect) {
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        analyzeImage(img);
      });
    }
    
    // Add context menu item
    img.addEventListener('contextmenu', (e) => {
      // Add custom context menu item
      // This is a simplified example - you'd need to implement the actual context menu
      console.log('Right-clicked on image:', img.src);
    });
  }

  // Check if an image is valid for processing
  function isValidImage(img) {
    if (!img || !img.src || img.complete === false) {
      return false;
    }
    
    // Skip already processed images
    if (processedElements.has(img)) {
      return false;
    }
    
    // Skip very small images (likely icons or UI elements)
    if (img.naturalWidth < 50 || img.naturalHeight < 50) {
      return false;
    }
    
    // Skip images with data URIs that are too small (likely placeholders)
    if (img.src.startsWith('data:') && img.src.length < 1000) {
      return false;
    }
    
    // Skip Facebook UI images
    if (img.src.includes('/rsrc.php/') || 
        img.src.includes('/images/') ||
        img.alt === 'Facebook' ||
        img.getAttribute('aria-label') === 'Facebook') {
      return false;
    }
    
    return true;
  }

  // Set up file upload listeners
  function setupUploadListeners() {
    // Handle file input changes
    document.addEventListener('change', (e) => {
      if (e.target.matches(CONFIG.SELECTORS.UPLOAD_INPUT) && e.target.files.length > 0) {
        handleFileUpload(e);
      }
    }, true);
    
    // Handle drag and drop
    document.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('Files')) {
        // Show drop zone indicator
      }
    });
    
    document.addEventListener('drop', (e) => {
      if (e.dataTransfer.files.length > 0) {
        handleFileUpload({ target: { files: e.dataTransfer.files } });
      }
    });
  }

  // Handle file upload
  async function handleFileUpload(event) {
    if (isProcessingUpload) return;
    
    const files = event.target.files;
    if (!files || files.length === 0) return;
    
    isProcessingUpload = true;
    
    // Show processing notification (single area)
    clearToasts();
    showNotification('AI Image Guard', 'Analyzing uploaded image', 'info');
    
    // Process each file
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      
      try {
        const img = await createImageFromFile(file);
        const result = await analyzeImage(img, 'upload');
        
        // Result badge intentionally disabled in this script
      } catch (error) {
        console.error('Error processing uploaded image:', error);
      }
    }
    
    // Reset the input value to allow re-uploading the same file
    if (event.target.value) {
      event.target.value = '';
    }
    
    // Result toast lifetime controlled within showNotification; nothing to remove here
    
    isProcessingUpload = false;
  }

  // Create an image element from a file
  function createImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // Find the preview container for uploaded images
  function findPreviewContainer() {
    return document.querySelector(CONFIG.SELECTORS.PREVIEW_CONTAINER) || document.body;
  }

  // Analyze an image
  async function analyzeImage(img, sourceTag) {
    if (!img || !img.src) {
      console.error('No image provided for analysis');
      return null;
    }
    
    try {
      showNotification('AI Image Guard', 'Analyzing image', 'info');
      const badge = SHOW_BADGES ? createBadge('Analyzing...', 'info') : null;
      if (badge) addBadgeToImage(img, badge);
      const actionLabel = (sourceTag === 'upload') ? 'Upload interception' : 'On-click detect';
      
      // Prefer classifying by URL for network images to avoid tainted canvas
      let response = null;
      const src = getBestImageUrlForFb(img) || img.currentSrc || img.src || '';
      const isHttp = /^https?:\/\//i.test(src);
      if (isHttp) {
        try {
          response = await chrome.runtime.sendMessage({ action: 'classifyUrl', url: src, source: 'facebook', user_action: actionLabel, detection_type: actionLabel });
        } catch (_) {
          response = null; // fall through to other strategies
        }
      }

      // Handle blob: URLs by fetching and converting to base64 (no canvas)
      if (!response && src.startsWith('blob:')) {
        try {
          const dataUrl = await blobUrlToDataURL(src);
          if (dataUrl) {
            response = await chrome.runtime.sendMessage({ action: 'analyzeImage', imageData: dataUrl, source: 'facebook', user_action: actionLabel, detection_type: actionLabel });
          }
        } catch (_) {
          response = null;
        }
      }

      // As a last resort, try canvas extraction (may fail on cross-origin)
      if (!response) {
        const imageData = await getImageData(img);
        if (!imageData) {
          // One more fallback: attempt classifyUrl even if not http(s)
          try {
            response = await chrome.runtime.sendMessage({ action: 'classifyUrl', url: src, source: 'facebook', user_action: actionLabel, detection_type: actionLabel });
          } catch (e) {
            throw new Error('Could not get image data');
          }
        } else {
          response = await chrome.runtime.sendMessage({ action: 'analyzeImage', imageData, source: 'facebook', user_action: actionLabel, detection_type: actionLabel });
        }
      }
      
      if (!response || response.error) {
        throw new Error(response?.error || 'Failed to analyze image');
      }
      
      // Update badge with result (if enabled)
      const result = response.result;
      if (badge) updateBadge(badge, getResultLabel(result), getResultSeverity(result));
      // Replace analyzing banner with result banner
      clearToasts();
      const confidencePct = Math.round((result.confidence || 0) * 100);
      const complement = Math.max(0, 100 - confidencePct);
      if (result.is_fake) {
        showNotification('Likely AI-generated', `Confidence: ${confidencePct}%\nReal: ${complement}%`, 'warning');
      } else if (result.no_face) {
        showNotification('Analysis complete', 'No face detected in the image', 'info');
      } else {
        showNotification('Likely real', `Confidence: ${confidencePct}%\nAI: ${complement}%`, 'success');
      }
      
      return result;
    } catch (error) {
      console.error('Error analyzing image:', error);
      
      // Error badge disabled
      // Replace analyzing banner with error
      clearToasts();
      showNotification('Analysis error', error.message || 'Failed to analyze image', 'error');
      
      return null;
    }
  }

  // Get image data as base64
  function getImageData(img) {
    return new Promise((resolve) => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // Set canvas dimensions
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        
        // Draw image on canvas
        ctx.drawImage(img, 0, 0);
        
        // Get image data
        const imageData = canvas.toDataURL('image/jpeg', 0.9);
        resolve(imageData);
      } catch (error) {
        // Likely a cross-origin taint; return null quietly so caller can fallback
        resolve(null);
      }
    });
  }

  // Choose a good URL for Facebook images (prefer largest srcset/currentSrc)
  function getBestImageUrlForFb(imgEl) {
    try {
      if (!imgEl) return null;
      const base = (imgEl.ownerDocument && imgEl.ownerDocument.baseURI) || document.baseURI || location.href;
      const toAbs = (u) => { try { return new URL(u, base).href; } catch (_) { return u; } };
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
      if (imgEl.currentSrc) return toAbs(imgEl.currentSrc);
      return imgEl.src ? toAbs(imgEl.src) : null;
    } catch (_) {
      return imgEl && (imgEl.currentSrc || imgEl.src) || null;
    }
  }

  // Convert a blob: URL to a data URL without drawing to canvas
  async function blobUrlToDataURL(blobUrl) {
    const resp = await fetch(blobUrl);
    if (!resp.ok) throw new Error(`Blob fetch failed: ${resp.status}`);
    const blob = await resp.blob();
    return await new Promise((resolve, reject) => {
      try {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      } catch (e) { reject(e); }
    });
  }

  // Create a badge element
  function createBadge(text, type = 'info') {
    const badge = document.createElement('div');
    badge.className = 'ai-detector-badge';
    
    // Apply styles
    Object.assign(badge.style, CONFIG.BADGE_STYLES, {
      backgroundColor: CONFIG.COLORS[type] || CONFIG.COLORS.default
    });
    
    badge.textContent = text;
    return badge;
  }

  // Create a result badge based on analysis result
  function createResultBadge(result) {
    const label = getResultLabel(result);
    const severity = getResultSeverity(result);
    return createBadge(label, severity);
  }

  // Add a badge to an image
  function addBadgeToImage(img, badge) {
    if (!img || !badge) return;
    
    // Position the badge
    const rect = img.getBoundingClientRect();
    badge.style.position = 'absolute';
    badge.style.top = `${rect.top + window.scrollY + 10}px`;
    badge.style.left = `${rect.left + window.scrollX + 10}px`;
    
    // Add to document
    document.body.appendChild(badge);
    
    // Remove badge on click
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      badge.remove();
    });
    
    return badge;
  }

  // Update badge text and style
  function updateBadge(badge, text, type = 'info') {
    if (!badge) return;
    
    badge.textContent = text;
    badge.style.backgroundColor = CONFIG.COLORS[type] || CONFIG.COLORS.default;
    
    // Auto-remove after delay
    setTimeout(() => {
      try { badge.remove(); } catch (e) {}
    }, 10000);
  }

  // Toast management: single area, replace content
  function clearToasts() {
    const container = document.getElementById('deepfake-toast-container');
    if (container) while (container.firstChild) container.removeChild(container.firstChild);
    if (currentToastTimer) { clearTimeout(currentToastTimer); currentToastTimer = null; }
    currentToast = null;
  }

  function showNotification(title, message, type = 'info') {
    if (!SHOW_TOASTS) return null;
    const normalized = {
      title: String(title || ''),
      message: String(message || ''),
      type: String(type || 'info')
    };
    if (currentToast && currentToastData &&
        currentToastData.title === normalized.title &&
        currentToastData.message === normalized.message &&
        currentToastData.type === normalized.type) {
      return currentToast;
    }
    if (currentToast) {
      const variants = {
        info:   { border: '#0ea5e9', bg: '#0b1220', fg: '#e5f6ff' },
        success:{ border: '#22c55e', bg: '#0c1a14', fg: '#eafff1' },
        warning:{ border: '#f59e0b', bg: '#1a150b', fg: '#fff7e6' },
        error:  { border: '#ef4444', bg: '#1a0b0b', fg: '#ffecec' }
      };
      const v = variants[normalized.type] || variants.info;
      currentToast.style.background = v.bg;
      currentToast.style.color = v.fg;
      currentToast.style.borderLeft = `4px solid ${v.border}`;
      const content = currentToast.firstChild;
      if (content && content.firstChild) content.firstChild.textContent = normalized.title;
      if (content && content.children && content.children[1]) content.children[1].textContent = normalized.message;
      currentToastData = normalized;
      try {
        if (!isApplyingStorageToast) {
          chrome.storage?.local?.set({ lastToast: { title: normalized.title, message: normalized.message, type: normalized.type, ts: Date.now(), source: CLIENT_ID } });
        }
      } catch (_) {}
      if (currentToastTimer) { clearTimeout(currentToastTimer); currentToastTimer = null; }
      const duration = CONFIG.NOTIFICATION_DURATION || 5000;
      const isAnalyzing = /^\s*Analyzing/i.test(String(normalized.message || ''));
      if (!isAnalyzing) {
        currentToastTimer = setTimeout(() => {
          if (currentToast && currentToast.parentNode) {
            currentToast.style.animation = 'fadeOut 200ms ease forwards';
            const toRemove = currentToast; currentToast = null; currentToastData = null; currentToastTimer = null;
            setTimeout(() => toRemove.remove(), 200);
            try { chrome.storage?.local?.set({ lastToast: null }); } catch (_) {}
          }
        }, duration);
      }
      return currentToast;
    }
    let container = document.getElementById('deepfake-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'deepfake-toast-container';
      Object.assign(container.style, {
        position: 'fixed', top: '16px', right: '16px', display: 'flex', flexDirection: 'column', gap: '10px', zIndex: '2147483647'
      });
      document.body.appendChild(container);
    }

    clearToasts();

    const variants = {
      info:   { border: '#0ea5e9', bg: '#0b1220', fg: '#e5f6ff' },
      success:{ border: '#22c55e', bg: '#0c1a14', fg: '#eafff1' },
      warning:{ border: '#f59e0b', bg: '#1a150b', fg: '#fff7e6' },
      error:  { border: '#ef4444', bg: '#1a0b0b', fg: '#ffecec' }
    };
    const v = variants[type] || variants.info;

    const toast = document.createElement('div');
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.style.cssText = `display:flex;align-items:start;gap:12px;padding:12px 14px;max-width:360px;background:${v.bg};color:${v.fg};border-left:4px solid ${v.border};border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,0.35);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;transform:translateX(120%);opacity:0;animation: slideIn 220ms ease forwards;`;

    const content = document.createElement('div');
    const titleEl = document.createElement('div');
    titleEl.textContent = title;
    titleEl.style.cssText = 'font-weight:600;letter-spacing:.2px;margin-bottom:2px;';
    const msgEl = document.createElement('div');
    msgEl.textContent = message;
    msgEl.style.cssText = 'opacity:.9;line-height:1.35;white-space:pre-line;';
    content.appendChild(titleEl);
    content.appendChild(msgEl);

    const closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', 'Close notification');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'margin-left:auto;background:transparent;border:none;color:inherit;cursor:pointer;font-size:14px;padding:2px;opacity:.7;';
    closeBtn.onclick = () => {
      toast.style.animation = 'slideOut 200ms ease forwards';
      setTimeout(() => toast.remove(), 200);
      currentToast = null; currentToastTimer = null; currentToastData = null;
      try { chrome.storage?.local?.set({ lastToast: null }); } catch (_) {}
    };

    toast.appendChild(content);
    toast.appendChild(closeBtn);
    container.appendChild(toast);
    currentToast = toast;
    currentToastData = normalized;

    // Persist toast so it can be rehydrated after page reloads
    try {
      if (!isApplyingStorageToast) {
        chrome.storage?.local?.set({ lastToast: { title: normalized.title, message: normalized.message, type: normalized.type, ts: Date.now(), source: CLIENT_ID } });
      }
    } catch (_) {}

    // Auto-dismiss unless this is an analyzing message, which should persist
    const duration = CONFIG.NOTIFICATION_DURATION || 5000;
    const isAnalyzing = /^\s*Analyzing/i.test(String(normalized.message || ''));
    if (!isAnalyzing) {
      currentToastTimer = setTimeout(() => {
        if (toast === currentToast && toast.parentNode) {
          toast.style.animation = 'fadeOut 200ms ease forwards';
          setTimeout(() => toast.remove(), 200);
          currentToast = null; currentToastTimer = null; currentToastData = null;
          try { chrome.storage?.local?.set({ lastToast: null }); } catch (_) {}
        }
      }, duration);
    }

    return toast;
  }

  // Get result label based on analysis
  function getResultLabel(result) {
    if (!result) return 'Unknown';
    
    if (result.no_face) {
      return 'No face detected';
    }
    
    const confidence = Math.round((result.confidence || 0) * 100);
    const displayPct = mapDisplayPercent(confidence);
    
    if (result.is_fake) {
      return `${displayPct}% likely AI`;
    } else {
      return `${displayPct}% likely real`;
    }
  }

  // Get result severity
  function getResultSeverity(result) {
    if (!result) return 'default';
    
    if (result.no_face) {
      return 'warning';
    }
    
    if (result.is_fake) {
      return result.confidence > CONFIG.DETECTION_THRESHOLD ? 'error' : 'warning';
    } else {
      return 'success';
    }
  }

  // Add styles
  function addStyles() {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      
      @keyframes fadeOut {
        from { opacity: 1; transform: translateY(0); }
        to { opacity: 0; transform: translateY(-10px); }
      }
      
      /* Added to match toast animation used in showNotification */
      @keyframes slideIn {
        from { transform: translateX(120%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      
      @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(120%); opacity: 0; }
      }
      
      .ai-detector-badge {
        cursor: pointer;
        transition: opacity 0.3s;
      }
      
      .ai-detector-badge:hover {
        opacity: 0.8 !important;
      }
    `;
    document.head.appendChild(style);
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      addStyles();
      initScanner();
      try {
        chrome.storage?.local?.get({ lastToast: null }, (items) => {
          const t = items?.lastToast;
          if (t && t.title) {
            showNotification(String(t.title || ''), String(t.message || ''), String(t.type || 'info'));
          }
        });
      } catch (_) {}
    });
  } else {
    addStyles();
    initScanner();
    try {
      chrome.storage?.local?.get({ lastToast: null }, (items) => {
        const t = items?.lastToast;
        if (t && t.title) {
          showNotification(String(t.title || ''), String(t.message || ''), String(t.type || 'info'));
        }
      });
    } catch (_) {}
  }
 
  // Listen for toast display requests from background scripts
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.action === 'showToast') {
        const title = msg.title || 'AI Image Guard';
        const message = msg.message || '';
        const type = msg.type || 'info';
        showNotification(title, message, type);
        return;
      }
      // Live settings update from options.js
      if (msg && msg.type === 'settingsUpdated' && msg.settings) {
        if (typeof msg.settings.realTimeScanning !== 'undefined') {
          SETTINGS.realTimeScanning = !!msg.settings.realTimeScanning;
          setPageScanning(SETTINGS.realTimeScanning);
        }
        if (typeof msg.settings.scanInterval !== 'undefined') {
          SETTINGS.scanInterval = Math.max(1, parseInt(msg.settings.scanInterval));
          if (pageScanEnabled && pageScanIntervalId) {
            clearInterval(pageScanIntervalId);
            pageScanIntervalId = setInterval(() => {
              try { scanForImages(); } catch (_) {}
            }, Math.max(1000, (SETTINGS.scanInterval || 3) * 1000));
          }
        }
      }
    });
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes?.lastToast?.newValue) {
        const t = changes.lastToast.newValue;
        if (!t) return;
        if (t.source && t.source === CLIENT_ID) return;
        if (t.title) {
          isApplyingStorageToast = true;
          try {
            showNotification(String(t.title || ''), String(t.message || ''), String(t.type || 'info'));
          } finally {
            isApplyingStorageToast = false;
          }
        }
      }
    });
  } catch (e) {
    // no-op
  }
  
  console.log('Facebook content script loaded');
})();
