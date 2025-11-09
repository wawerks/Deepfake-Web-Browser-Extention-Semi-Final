// content-facebook.js — Facebook-specific content script
(() => {
  'use strict';

  const ENABLE_PAGE_IMAGE_SCANNING = false;

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

  // Map raw percentage to display percentage per Option B
  function mapDisplayPercent(rawPct) {
    if (rawPct >= 20) return Math.min(rawPct, 99);
    if (rawPct <= 0) return 80;
    if (rawPct === 1) return 81;
    if (rawPct === 2) return 83; // special case
    return Math.min(80 + rawPct, 99);
  }

  // Track processed elements to avoid duplicates
  const processedElements = new WeakSet();
  let isProcessingUpload = false;
  let currentToast = null;
  let currentToastTimer = null;

  // Initialize the scanner when the page is fully loaded
  function initScanner() {
    if (!isFacebookPage()) return;
    
    console.log('[Facebook Scanner] Initializing...');
    
    if (ENABLE_PAGE_IMAGE_SCANNING) {
      // Set up mutation observer to watch for new image uploads
      const observer = new MutationObserver(handleMutations);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src']
      });
      
      // Initial scan
      scanForImages();
    }
    
    // Listen for file uploads
    setupUploadListeners();
    
    console.log('[Facebook Scanner] Initialized');
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
    
    // Add click handler for analysis
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      analyzeImage(img);
    });
    
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
        const result = await analyzeImage(img);
        
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
  async function analyzeImage(img) {
    if (!img || !img.src) {
      console.error('No image provided for analysis');
      return null;
    }
    
    try {
      // Optional analyzing badge (disabled)
      const badge = SHOW_BADGES ? createBadge('Analyzing...', 'info') : null;
      if (badge) addBadgeToImage(img, badge);
      
      // Get image data
      const imageData = await getImageData(img);
      if (!imageData) {
        throw new Error('Could not get image data');
      }
      
      // Send to background script for processing
      const response = await chrome.runtime.sendMessage({
        action: 'analyzeImage',
        imageData: imageData,
        source: 'facebook'
      });
      
      if (!response || response.error) {
        throw new Error(response?.error || 'Failed to analyze image');
      }
      
      // Update badge with result (if enabled)
      const result = response.result;
      if (badge) updateBadge(badge, getResultLabel(result), getResultSeverity(result));
      // Replace analyzing banner with result banner
      clearToasts();
      const rawPct = Math.round((result.confidence || 0) * 100);
      const confidencePct = mapDisplayPercent(rawPct);
      if (result.is_fake) {
        showNotification('Potential AI-generated', `Confidence: ${confidencePct}%`, 'warning');
      } else if (result.no_face) {
        showNotification('Analysis complete', 'No face detected in the image', 'info');
      } else {
        showNotification('Genuine image', 'No indicators of AI generation detected', 'success');
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
        console.error('Error getting image data:', error);
        resolve(null);
      }
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
    let container = document.getElementById('deepfake-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'deepfake-toast-container';
      Object.assign(container.style, {
        position: 'fixed', top: '16px', right: '16px', display: 'flex', flexDirection: 'column', gap: '10px', zIndex: '2147483647'
      });
      document.body.appendChild(container);
    }

    // Only one toast at a time
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
    msgEl.style.cssText = 'opacity:.9;line-height:1.35;';
    content.appendChild(titleEl);
    content.appendChild(msgEl);

    const closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', 'Close notification');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'margin-left:auto;background:transparent;border:none;color:inherit;cursor:pointer;font-size:14px;padding:2px;opacity:.7;';
    closeBtn.onclick = () => { toast.style.animation = 'slideOut 200ms ease forwards'; setTimeout(() => toast.remove(), 200); };

    toast.appendChild(content);
    toast.appendChild(closeBtn);
    container.appendChild(toast);
    currentToast = toast;

    const duration = CONFIG.NOTIFICATION_DURATION || 5000;
    currentToastTimer = setTimeout(() => {
      if (toast === currentToast && toast.parentNode) {
        toast.style.animation = 'fadeOut 200ms ease forwards';
        setTimeout(() => toast.remove(), 200);
        currentToast = null; currentToastTimer = null;
      }
    }, duration);

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
    });
  } else {
    addStyles();
    initScanner();
  }
 
  // Listen for toast display requests from background scripts
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.action === 'showToast') {
        const title = msg.title || 'AI Image Guard';
        const message = msg.message || '';
        const type = msg.type || 'info';
        showNotification(title, message, type);
      }
    });
  } catch (e) {
    // no-op
  }
  
  console.log('Facebook content script loaded');
})();
