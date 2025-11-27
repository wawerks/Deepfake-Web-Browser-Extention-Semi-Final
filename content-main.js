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
  
   // =============================================================
// Extract the best, ORIGINAL full-resolution CDN URL
// =============================================================
function extractOriginalImageUrl(img) {
  try {
    const base = document.baseURI || location.href;
    const toAbs = (u) => {
      try { return new URL(u, base).href; } catch (_) { return u; }
    };

    // Check if image is inside .mainContainer - if so, prioritize finding the real source
    const mainContainer = img.closest?.('.mainContainer');
    
    // 1. Prefer srcset (largest candidate)
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      const candidates = srcset
        .split(',')
        .map(s => s.trim())
        .map(item => {
          const parts = item.split(' ');
          const url = parts[0];
          const w = parts.find(p => p.endsWith('w'));
          const width = w ? parseInt(w) : 0;
          return { url: toAbs(url), width };
        })
        .filter(c => c.url);

      if (candidates.length > 0) {
        candidates.sort((a, b) => b.width - a.width);
        const bestSrcsetUrl = candidates[0].url;
        // Skip data URLs from srcset if we're in mainContainer (likely thumbnails)
        if (mainContainer && bestSrcsetUrl.startsWith('data:')) {
          console.log("[AI Image Guard Debug] Skipping data URL from srcset in mainContainer, checking other sources");
        } else {
          return bestSrcsetUrl;
        }
      }
    }

    // 2. Check for lazy-loading attributes (data-src, data-original, etc.) - these often have the real URL
    const lazyAttrs = ['data-src', 'data-original', 'data-lazy-src', 'data-srcset', 'data-original-src'];
    for (const attr of lazyAttrs) {
      const lazyUrl = img.getAttribute(attr);
      if (lazyUrl && !lazyUrl.startsWith('data:') && (lazyUrl.startsWith('http://') || lazyUrl.startsWith('https://'))) {
        console.log("[AI Image Guard Debug] Found lazy-load URL in", attr, ":", lazyUrl.substring(0, 100));
        return toAbs(lazyUrl);
      }
    }

    // 3. If in mainContainer, check parent container for URL hints
    if (mainContainer) {
      // Check parent for data attributes that might contain the real URL
      for (const attr of lazyAttrs) {
        const parentUrl = mainContainer.getAttribute(attr);
        if (parentUrl && !parentUrl.startsWith('data:') && (parentUrl.startsWith('http://') || parentUrl.startsWith('https://'))) {
          console.log("[AI Image Guard Debug] Found URL in mainContainer", attr, ":", parentUrl.substring(0, 100));
          return toAbs(parentUrl);
        }
      }
      
      // Check for link elements inside mainContainer that might point to the full image
      const linkInContainer = mainContainer.querySelector('a[href]');
      if (linkInContainer) {
        const linkHref = linkInContainer.getAttribute('href');
        // Check if it's an image URL
        if (linkHref && (linkHref.match(/\.(jpg|jpeg|png|webp|gif)/i) || linkHref.includes('image'))) {
          if (!linkHref.startsWith('data:') && (linkHref.startsWith('http://') || linkHref.startsWith('https://'))) {
            console.log("[AI Image Guard Debug] Found image URL in mainContainer link:", linkHref.substring(0, 100));
            return toAbs(linkHref);
          }
        }
      }
    }

    // 4. Fallback to currentSrc (but skip if it's a data URL and we're in mainContainer)
    if (img.currentSrc) {
      if (mainContainer && img.currentSrc.startsWith('data:')) {
        console.log("[AI Image Guard Debug] Skipping data URL from currentSrc in mainContainer");
      } else {
        return toAbs(img.currentSrc);
      }
    }

    // 5. Fallback to src (but skip if it's a data URL and we're in mainContainer)
    if (img.src) {
      if (mainContainer && img.src.startsWith('data:')) {
        console.log("[AI Image Guard Debug] Image src is data URL in mainContainer, checking for alternatives...");
        // Try to find any HTTP/HTTPS URL in nearby elements
        const allLinks = mainContainer.querySelectorAll('a[href], [data-src], [data-original]');
        for (const el of allLinks) {
          const url = el.getAttribute('href') || el.getAttribute('data-src') || el.getAttribute('data-original');
          if (url && !url.startsWith('data:') && (url.startsWith('http://') || url.startsWith('https://'))) {
            console.log("[AI Image Guard Debug] Found alternative HTTP URL:", url.substring(0, 100));
            return toAbs(url);
          }
        }
        // If no alternative found, return the data URL (better than nothing)
        return toAbs(img.src);
      } else {
        return toAbs(img.src);
      }
    }

    return null;
  } catch (err) {
    console.warn("extractOriginalImageUrl failed:", err);
    return img.currentSrc || img.src || null;
  }
}


// =============================================================
// ON-CLICK DETECTION (same pipeline as right-click)
// =============================================================
document.addEventListener('click', async (e) => {
  try {
    if (!clickToDetectEnabled) return;

    const now = Date.now();
    if (now - lastClickTs < 800) return;
    lastClickTs = now;

    // identify clicked image - prioritize images within .mainContainer (full-size images, not thumbnails)
    let img = null;
    
    // Strategy 1: Check if click is within a .mainContainer and find the img inside it
    if (typeof e.clientX === 'number' && typeof e.clientY === 'number' && document.elementsFromPoint) {
      try {
        const elementsAtPoint = document.elementsFromPoint(e.clientX, e.clientY);
        
        // First, look for a .mainContainer element
        const mainContainer = elementsAtPoint.find(el => 
          el && el.classList && el.classList.contains('mainContainer')
        );
        
        if (mainContainer) {
          // Find the img element within the mainContainer
          const imgInMainContainer = mainContainer.querySelector('img');
          if (imgInMainContainer && imgInMainContainer instanceof HTMLImageElement) {
            img = imgInMainContainer;
            console.log("[AI Image Guard Debug] Found image in .mainContainer:", {
              src: img.src?.substring(0, 100),
              naturalWidth: img.naturalWidth,
              naturalHeight: img.naturalHeight
            });
          }
        }
        
        // If no mainContainer image found, try to find any img at click point
        if (!img) {
        img = elementsAtPoint.find(el => el && el.tagName === 'IMG' && el instanceof HTMLImageElement);
        }
      } catch (err) {
        console.warn("elementsFromPoint failed:", err);
      }
    }
    
    // Strategy 2: Check if clicked element or its parent is within .mainContainer
    if (!img && e.target && typeof e.target.closest === 'function') {
      const mainContainer = e.target.closest('.mainContainer');
      if (mainContainer) {
        const imgInMainContainer = mainContainer.querySelector('img');
        if (imgInMainContainer && imgInMainContainer instanceof HTMLImageElement) {
          img = imgInMainContainer;
          console.log("[AI Image Guard Debug] Found image in .mainContainer (via closest):", {
            src: img.src?.substring(0, 100),
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight
          });
        }
      }
      
      // Fallback to closest image if no mainContainer found
      if (!img) {
      img = e.target.closest('img');
      }
    }
    
    // Strategy 3: Check composed path for .mainContainer
    if (!img && typeof e.composedPath === 'function') {
      const path = e.composedPath();
      const mainContainer = path?.find(el => 
        el && el.classList && el.classList.contains('mainContainer')
      );
      
      if (mainContainer) {
        const imgInMainContainer = mainContainer.querySelector('img');
        if (imgInMainContainer && imgInMainContainer instanceof HTMLImageElement) {
          img = imgInMainContainer;
          console.log("[AI Image Guard Debug] Found image in .mainContainer (via composedPath):", {
            src: img.src?.substring(0, 100),
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight
          });
        }
      }
      
      // Last resort: find any img in the path
      if (!img) {
      img = path?.find(n => n && n.tagName === 'IMG' && n instanceof HTMLImageElement);
      }
    }
    
    if (!img || !(img instanceof HTMLImageElement)) return;

    if (!img.src || img.naturalWidth < 80 || img.naturalHeight < 80) return;

    // Filter out small profile pictures/chat heads (especially on Facebook)
    // Chat heads and profile pictures are typically very small (32x32 to 64x64 pixels)
    const isFacebook = window.location.hostname.includes('facebook.com') || window.location.hostname.includes('fb.com');
    const isSmallProfilePicture = (img.naturalWidth <= 100 && img.naturalHeight <= 100) || 
                                   (img.width <= 64 && img.height <= 64);
    
    // Check if image is in a profile picture container (common Facebook patterns)
    const isInProfileContainer = img.closest('[role="img"]') !== null ||
                                  img.closest('[aria-label*="profile"]') !== null ||
                                  img.closest('[aria-label*="Profile picture"]') !== null ||
                                  img.closest('a[href*="/profile"]') !== null ||
                                  img.closest('a[href*="/user"]') !== null ||
                                  img.closest('[class*="profile"]') !== null ||
                                  img.closest('[class*="avatar"]') !== null ||
                                  img.closest('[class*="chat"]') !== null;
    
    // Skip small profile pictures on Facebook
    if (isFacebook && (isSmallProfilePicture || isInProfileContainer)) {
      console.log("[AI Image Guard Debug] Skipping small profile picture/chat head:", {
        naturalSize: `${img.naturalWidth}x${img.naturalHeight}`,
        displayedSize: `${img.width}x${img.height}`,
        isSmallProfilePicture,
        isInProfileContainer
      });
      return;
    }

    // Check if there's an open dialog/modal and if the clicked image is behind it
    // This prevents detecting images behind Facebook upload dialogs or other modals
    try {
      // Check for any open dialogs/modals on the page
      const openDialogs = document.querySelectorAll(
        'div[role="dialog"]:not([aria-hidden="true"]), ' +
        'div[role="alertdialog"]:not([aria-hidden="true"]), ' +
        '[aria-modal="true"]:not([aria-hidden="true"])'
      );
      
      if (openDialogs.length > 0) {
        // Check if the clicked image is inside any of the open dialogs
        const isImageInDialog = Array.from(openDialogs).some(dialog => dialog.contains(img));
        
        // Also check if any dialog is visually overlapping the click point
        // (using elementsFromPoint to see what's actually at the click coordinates)
        let hasDialogAtClickPoint = false;
        if (typeof e.clientX === 'number' && typeof e.clientY === 'number' && document.elementsFromPoint) {
          try {
            const elementsAtPoint = document.elementsFromPoint(e.clientX, e.clientY);
            hasDialogAtClickPoint = Array.from(openDialogs).some(dialog => 
              elementsAtPoint.includes(dialog) || elementsAtPoint.some(el => dialog.contains(el))
            );
          } catch (_) {}
        }
        
        if (!isImageInDialog && hasDialogAtClickPoint) {
          // Image is NOT inside any dialog, but a dialog is at the click point
          // This means the image is behind the dialog - ignore the click
          console.log("[AI Image Guard Debug] Blocked click - image behind dialog");
          return;
        }
        // If image IS inside a dialog OR no dialog is at click point, allow detection
      }
    } catch (err) {
      // If check fails, continue with normal processing
      console.warn("Dialog check failed:", err);
    }

    // -------------------------------------------------------------
    // DETECT IF CLICKED IMAGE IS A THUMBNAIL
    // -------------------------------------------------------------
    const isThumbnail = (() => {
      // Check if URL is a thumbnail URL (Bing thumbnails, etc.)
      const imgSrc = img.src || img.currentSrc || '';
      const isBingThumbnail = imgSrc.includes('th.bing.com/th/id/') || 
                               imgSrc.includes('th.bing.com/th/') ||
                               imgSrc.startsWith('https://th.bing.com');
      
      // Check for other common thumbnail URL patterns
      const thumbnailUrlPatterns = [
        /th\.bing\.com/i,
        /thumbnail/i,
        /thumb/i,
        /_thumb/i,
        /_small/i,
        /_preview/i,
        /w=\d+&h=\d+/i, // URL parameters indicating thumbnail size
        /\?w=\d+&h=\d+/i
      ];
      const hasThumbnailUrl = thumbnailUrlPatterns.some(pattern => pattern.test(imgSrc));
      
      // Check if displayed size is much smaller than natural size (common thumbnail pattern)
      const sizeRatio = img.naturalWidth > 0 && img.width > 0 
        ? img.naturalWidth / img.width 
        : 0;
      
      // Thumbnails typically have naturalWidth >> displayed width (ratio > 2)
      // Also check if image is very small (common thumbnail size)
      const isSmallDisplay = img.width < 300 && img.height < 300;
      const hasLargeSizeRatio = sizeRatio > 2;
      
      // Check if image is not fully loaded (common for thumbnails)
      const notFullyLoaded = !img.complete || img.naturalWidth === 0 || img.naturalHeight === 0;
      
      // Check if image is in a thumbnail container (common class names)
      const thumbnailContainers = ['thumbnail', 'thumb', 'preview', 'gallery-item', 'grid-item'];
      const isInThumbnailContainer = thumbnailContainers.some(className => 
        img.closest(`.${className}`) !== null
      );
      
      const isThumb = isBingThumbnail || hasThumbnailUrl || isSmallDisplay || hasLargeSizeRatio || notFullyLoaded || isInThumbnailContainer;
      
      console.log("[AI Image Guard Debug] Thumbnail detection:", {
        isThumbnail: isThumb,
        isBingThumbnail,
        hasThumbnailUrl,
        imgSrc: imgSrc.substring(0, 100),
        displayedSize: `${img.width}x${img.height}`,
        naturalSize: `${img.naturalWidth}x${img.naturalHeight}`,
        sizeRatio: sizeRatio.toFixed(2),
        isSmallDisplay,
        hasLargeSizeRatio,
        notFullyLoaded,
        isInThumbnailContainer
      });
      
      return isThumb;
    })();

    // -------------------------------------------------------------
    // IF THUMBNAIL: WAIT FOR FULL IMAGE TO LOAD (like right-click does)
    // -------------------------------------------------------------
    // Declare outside block so it's accessible later
    let fullImageUrlFromPage = null;
    
    if (isThumbnail) {
      showToast("AI Image Guard", "Waiting for full image...", "info");
      
      // For Bing detail pages, try to extract full URL from page URL parameters first
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const mediaUrl = urlParams.get('mediaurl');
        if (mediaUrl) {
          fullImageUrlFromPage = decodeURIComponent(mediaUrl);
          console.log("[AI Image Guard Debug] Found full image URL in page URL:", fullImageUrlFromPage.substring(0, 150));
        }
      } catch (err) {
        console.warn("[AI Image Guard Debug] Failed to parse URL parameters:", err);
      }
      
      // Wait for .mainContainer or similar main image container to appear
      let mainContainer = null;
      let mainImage = null;
      
      // Common main image container class names (including Bing-specific)
      const mainContainerSelectors = [
        '.mainContainer',
        '.main-image',
        '.full-image',
        '.image-viewer',
        '.lightbox-image',
        '.modal-image',
        '.imgContainer', // Bing uses this
        '.richImage', // Bing uses this
        '[class*="main"]',
        '[class*="full"]',
        '[class*="viewer"]',
        '[class*="detail"]', // Bing detail pages
        '[id*="main"]',
        '[id*="full"]'
      ];
      
      const findMainContainer = () => {
        // Check if mainContainer already exists
        for (const selector of mainContainerSelectors) {
          try {
            const containers = document.querySelectorAll(selector);
            for (const container of containers) {
              const imgInContainer = container.querySelector('img');
              if (imgInContainer && imgInContainer instanceof HTMLImageElement) {
                // Check if this image is larger/different from the thumbnail
                const isLarger = imgInContainer.naturalWidth > img.naturalWidth || 
                                imgInContainer.naturalHeight > img.naturalHeight;
                const isDifferent = imgInContainer.src !== img.src;
                const isNotThumbnail = !isThumbnailUrl(imgInContainer.src);
                
                if ((isLarger || isDifferent) && isNotThumbnail) {
                  return { container, img: imgInContainer };
                }
              }
            }
          } catch (err) {
            // Skip invalid selectors
            continue;
          }
        }
        return null;
      };
      
      // Wait up to 5 seconds for main container to appear (longer wait for dynamic pages)
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const result = findMainContainer();
        if (result) {
          mainContainer = result.container;
          mainImage = result.img;
          console.log("[AI Image Guard Debug] Found main image container:", {
            containerClass: mainContainer.className,
            containerId: mainContainer.id,
            thumbnailSrc: img.src?.substring(0, 100),
            mainImageSrc: mainImage.src?.substring(0, 100),
            thumbnailSize: `${img.naturalWidth}x${img.naturalHeight}`,
            mainImageSize: `${mainImage.naturalWidth}x${mainImage.naturalHeight}`
          });
          break;
        }
      }
      
      if (mainImage) {
        // Replace img reference with the main image
        const oldSrc = img.src;
        img = mainImage;
        console.log("[AI Image Guard Debug] Switched to main image:", {
          oldSrc: oldSrc?.substring(0, 100),
          newSrc: img.src?.substring(0, 100),
          oldSize: `${img.naturalWidth}x${img.naturalHeight}`,
          newSize: `${mainImage.naturalWidth}x${mainImage.naturalHeight}`
        });
        showToast("AI Image Guard", "Full image found, waiting for load...", "info");
      } else if (fullImageUrlFromPage) {
        // Use URL from page parameters if main container not found
        console.log("[AI Image Guard Debug] Using full image URL from page URL parameters");
        // We'll use this URL later in extraction
      } else {
        console.warn("[AI Image Guard Debug] Main container not found, will wait for image to load");
        showToast("AI Image Guard", "Waiting for image to load...", "info");
      }
    } else {
      showToast("AI Image Guard", "Waiting for image to load...", "info");
    }

    // -------------------------------------------------------------
    // WAIT FOR IMAGE TO FULLY LOAD
    // -------------------------------------------------------------
    try {
      // Wait for image to be complete and have natural dimensions
      if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) {
        console.log("[AI Image Guard Debug] Image not fully loaded, waiting...", {
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight
        });
        
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            console.warn("[AI Image Guard Debug] Image load timeout after 5 seconds");
            resolve(); // Continue anyway after timeout
          }, 5000);
          
          if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
            clearTimeout(timeout);
            resolve();
            return;
          }
          
          img.onload = () => {
            clearTimeout(timeout);
            console.log("[AI Image Guard Debug] Image loaded successfully");
            resolve();
          };
          
          img.onerror = () => {
            clearTimeout(timeout);
            console.warn("[AI Image Guard Debug] Image load error");
            resolve(); // Continue anyway
          };
        });
      }

      // Wait for any lazy-loading attributes to be swapped to src
      const lazyAttrs = ['data-src', 'data-original', 'data-lazy-src'];
      for (const attr of lazyAttrs) {
        if (img.getAttribute(attr)) {
          console.log(`[AI Image Guard Debug] Found lazy-load attribute ${attr}, waiting for swap...`);
          // Wait up to 2 seconds for the lazy-load to complete
          for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!img.getAttribute(attr) || img.src !== img.getAttribute(attr)) {
              console.log(`[AI Image Guard Debug] Lazy-load attribute swapped to src`);
              break;
            }
          }
          break;
        }
      }

      // Final check: ensure image has loaded dimensions
      if (img.naturalWidth === 0 || img.naturalHeight === 0) {
        console.warn("[AI Image Guard Debug] Image still has no natural dimensions after waiting");
        showToast("AI Image Guard", "Image failed to load properly", "error");
        return;
      } else {
        console.log("[AI Image Guard Debug] Image fully loaded:", {
          naturalDimensions: `${img.naturalWidth}x${img.naturalHeight}`,
          displayedDimensions: `${img.width}x${img.height}`,
          src: img.src?.substring(0, 100),
          currentSrc: img.currentSrc?.substring(0, 100),
          hasMainContainer: !!img.closest?.('.mainContainer')
        });
        showToast("AI Image Guard", "Image loaded, fetching source...", "info");
      }
    } catch (waitErr) {
      console.warn("[AI Image Guard Debug] Error waiting for image load:", waitErr);
      showToast("AI Image Guard", "Error waiting for image", "error");
      return;
    }

    // -------------------------------------------------------------
    // STEP 1 — Extract the full-resolution URL after image is loaded
    // Try multiple strategies to get the actual full-size URL (like right-click does)
    // -------------------------------------------------------------
    
    // Strategy: Look for the actual image URL that the browser would provide (like info.srcUrl in right-click)
    // This means checking multiple sources and preferring HTTP URLs over data URLs
    
    let bestUrl = null;
    const isInMainContainer = img.closest?.('.mainContainer') !== null;
    
    // Helper function to check if URL is a thumbnail
    const isThumbnailUrl = (url) => {
      if (!url) return false;
      const urlStr = String(url).toLowerCase();
      return urlStr.includes('th.bing.com/th/id/') || 
             urlStr.includes('th.bing.com/th/') ||
             urlStr.includes('thumbnail') ||
             urlStr.includes('_thumb') ||
             urlStr.includes('_small') ||
             urlStr.includes('_preview') ||
             /th\.bing\.com/i.test(urlStr);
    };
    
    // 0. First priority: Use URL from page parameters (for Bing detail pages, etc.)
    // This is the most reliable source, similar to how right-click uses info.srcUrl
    if (fullImageUrlFromPage && !isThumbnailUrl(fullImageUrlFromPage)) {
      bestUrl = fullImageUrlFromPage;
      console.log("[AI Image Guard Debug] Using full image URL from page URL parameters:", bestUrl.substring(0, 150));
    }
    
    // 1. First, try to get the largest URL from srcset (most reliable for full-size)
    // Only if we don't already have a URL from page parameters
    if (!bestUrl) {
      const srcset = img.getAttribute('srcset');
      if (srcset) {
        const base = document.baseURI || location.href;
        const toAbs = (u) => {
          try { return new URL(u, base).href; } catch (_) { return u; }
        };
        
        const candidates = srcset
          .split(',')
          .map(s => s.trim())
          .map(item => {
            const parts = item.split(' ');
            const url = parts[0];
            const w = parts.find(p => p.endsWith('w'));
            const width = w ? parseInt(w) : 0;
            return { url: toAbs(url), width };
          })
          .filter(c => c.url && !c.url.startsWith('data:') && !isThumbnailUrl(c.url)); // Skip data URLs and thumbnails
        
        if (candidates.length > 0) {
          candidates.sort((a, b) => b.width - a.width);
          bestUrl = candidates[0].url;
          console.log("[AI Image Guard Debug] Using largest srcset URL (non-thumbnail):", {
            url: bestUrl.substring(0, 150),
            width: candidates[0].width,
            totalCandidates: candidates.length
          });
        }
      }
    }
    
    // 2. If no srcset or srcset only has data/thumbnail URLs, check currentSrc (browser's selected source)
    if (!bestUrl || bestUrl.startsWith('data:') || isThumbnailUrl(bestUrl)) {
      if (img.currentSrc && !img.currentSrc.startsWith('data:') && !isThumbnailUrl(img.currentSrc)) {
        bestUrl = img.currentSrc;
        console.log("[AI Image Guard Debug] Using currentSrc (non-thumbnail):", bestUrl.substring(0, 150));
      }
    }
    
    // 3. Check lazy-loading attributes (often contain the real full-size URL)
    if (!bestUrl || bestUrl.startsWith('data:') || isThumbnailUrl(bestUrl)) {
      const lazyAttrs = ['data-src', 'data-original', 'data-lazy-src', 'data-full-src', 'data-original-src'];
      for (const attr of lazyAttrs) {
        const lazyUrl = img.getAttribute(attr);
        if (lazyUrl && !lazyUrl.startsWith('data:') && !isThumbnailUrl(lazyUrl) && (lazyUrl.startsWith('http://') || lazyUrl.startsWith('https://'))) {
          bestUrl = lazyUrl;
          console.log("[AI Image Guard Debug] Found lazy-load URL in", attr, ":", bestUrl.substring(0, 150));
          break;
        }
      }
    }
    
    // 4. If in mainContainer, check container and parent elements for URL hints
    if ((!bestUrl || bestUrl.startsWith('data:') || isThumbnailUrl(bestUrl)) && isInMainContainer) {
      const mainContainer = img.closest('.mainContainer');
      if (mainContainer) {
        // Check container's data attributes
        const containerAttrs = ['data-src', 'data-original', 'data-image-url', 'data-full-image', 'data-full-src'];
        for (const attr of containerAttrs) {
          const url = mainContainer.getAttribute(attr);
          if (url && !url.startsWith('data:') && !isThumbnailUrl(url) && (url.startsWith('http://') || url.startsWith('https://'))) {
            bestUrl = url;
            console.log("[AI Image Guard Debug] Found URL in mainContainer", attr, ":", bestUrl.substring(0, 150));
            break;
          }
        }
        
        // Check for link elements that might point to full image
        if (!bestUrl || bestUrl.startsWith('data:') || isThumbnailUrl(bestUrl)) {
          const links = mainContainer.querySelectorAll('a[href]');
          for (const link of links) {
            const href = link.getAttribute('href');
            if (href && !href.startsWith('data:') && !isThumbnailUrl(href) && (href.startsWith('http://') || href.startsWith('https://'))) {
              // Check if it looks like an image URL
              if (href.match(/\.(jpg|jpeg|png|webp|gif)/i) || href.includes('image') || href.includes('img')) {
                bestUrl = href;
                console.log("[AI Image Guard Debug] Found image URL in mainContainer link:", bestUrl.substring(0, 150));
                break;
              }
            }
          }
        }
      }
    }
    
    // 5. Fallback to extractOriginalImageUrl (but skip thumbnails and prefer HTTP URLs)
    if (!bestUrl || bestUrl.startsWith('data:') || isThumbnailUrl(bestUrl)) {
      const extractedUrl = extractOriginalImageUrl(img);
      if (extractedUrl && !extractedUrl.startsWith('data:') && !isThumbnailUrl(extractedUrl)) {
        bestUrl = extractedUrl;
        console.log("[AI Image Guard Debug] Using extracted URL (non-thumbnail):", bestUrl.substring(0, 150));
      } else if (!bestUrl && extractedUrl && !isThumbnailUrl(extractedUrl)) {
        bestUrl = extractedUrl; // Use even if data URL if nothing else found (but not thumbnail)
      } else if (!bestUrl) {
        // Last resort: use extracted URL even if thumbnail (better than nothing)
        bestUrl = extractedUrl;
        console.warn("[AI Image Guard Debug] Warning: Only thumbnail URL available:", bestUrl?.substring(0, 150));
      }
    }
    
    // Final check: if we still have a thumbnail URL, warn and try to find alternative
    if (bestUrl && isThumbnailUrl(bestUrl)) {
      console.warn("[AI Image Guard Debug] Warning: Best URL is still a thumbnail:", bestUrl.substring(0, 150));
      console.warn("[AI Image Guard Debug] This may result in analyzing the thumbnail instead of full-size image");
    }
    
    // Enhanced logging for debugging URL extraction
    console.log("[AI Image Guard Debug] Final URL extraction result:", {
      bestUrl: bestUrl ? bestUrl.substring(0, 150) : null,
      urlType: bestUrl ? (bestUrl.startsWith('http') ? 'HTTP' : bestUrl.startsWith('data') ? 'DATA' : bestUrl.startsWith('blob') ? 'BLOB' : 'OTHER') : 'NONE',
      imgSrc: img.src?.substring(0, 100),
      imgCurrentSrc: img.currentSrc?.substring(0, 100),
      imgSrcset: img.getAttribute('srcset')?.substring(0, 100),
      isInMainContainer: isInMainContainer,
      naturalDimensions: `${img.naturalWidth}x${img.naturalHeight}`,
      displayedDimensions: `${img.width}x${img.height}`
    });

    // Track when "No URL available" notification is shown to ensure it stays visible for at least 5 seconds
    let noUrlNotificationTime = null;

    // Check if we have a valid image source (HTTP/HTTPS for URL classification, or data/blob for direct use)
    const hasHttpUrl = bestUrl && (bestUrl.startsWith('http://') || bestUrl.startsWith('https://'));
    const hasDataOrBlobUrl = bestUrl && (bestUrl.startsWith('data:') || bestUrl.startsWith('blob:'));
    const hasAnyUrl = hasHttpUrl || hasDataOrBlobUrl;

    // Only show "No URL available" if there's truly no URL at all
    if (!hasAnyUrl) {
      console.warn("[AI Image Guard Debug] No URL available for image:", {
        imgSrc: img.src,
        imgCurrentSrc: img.currentSrc,
        imgSrcset: img.getAttribute('srcset'),
        extractedUrl: bestUrl,
        willUseCanvas: true
      });
      noUrlNotificationTime = Date.now();
      showToast("AI Image Guard", "No URL available - using canvas extraction. Use right-click to detect for better results.", "info");
    } else if (hasDataOrBlobUrl) {
      // For data/blob URLs, we'll use them directly in canvas extraction (skip URL classification)
      console.log("[AI Image Guard Debug] Image has data/blob URL - will use directly in canvas extraction:", {
        urlType: bestUrl.startsWith('data:') ? 'data' : 'blob',
        urlPreview: bestUrl.substring(0, 100)
      });
    }

    // Try to fetch the image directly (like right-click detect) for HTTP/HTTPS URLs
    if (hasHttpUrl) {
      try {
        showToast("AI Image Guard", "Fetching image...", "info");
        
        console.log("[AI Image Guard Debug] Fetching image from URL:", bestUrl.substring(0, 150));
        
        // Fetch the image directly (like right-click does)
        const imgResp = await Promise.race([
          fetch(bestUrl, { mode: 'cors' }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Image fetch timed out.")), 15000))
        ]);
        
        if (!imgResp.ok) {
          throw new Error(`Image fetch ${imgResp.status}`);
        }
        
        const blob = await imgResp.blob();
        if (!blob || (blob.size !== undefined && blob.size === 0)) {
          throw new Error('Empty image blob');
        }

        // Convert blob to data URL for sending to background
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });

        showToast("AI Image Guard", "Analyzing image...", "info");

        // Send to background for classification (using analyzeImage with the fetched data)
        const resp = await sendMessageSafely({
          action: "analyzeImage",
          imageData: dataUrl,
          imageSource: bestUrl, // Pass the original URL for logging
          source: "click-to-detect",
          user_action: "On-click detect",
          detection_type: "On-click detect"
        });

        renderResultToast(resp?.result || resp);
        return;
      } catch (err) {
        console.warn("Image fetch failed (likely CORS), falling back to URL classification:", err);
        showToast("AI Image Guard", "Fetch failed, trying URL classification...", "info");
        
        // Fallback to URL classification (server will fetch the image, bypassing CORS)
        // This is the same fallback that right-click uses
        try {
          const resp = await sendMessageSafely({
            action: "classifyUrl",
            url: bestUrl,
            user_action: "On-click detect",
            detection_type: "On-click detect"
          });

          renderResultToast(resp?.result || resp);
          return;
        } catch (urlErr) {
          console.error("URL classification also failed:", urlErr);
          showToast("Analysis error", `Could not analyze image: ${urlErr.message || err.message}`, "error");
          return;
        }
      }
    }

    // -------------------------------------------------------------
    // STEP 2 — Handle data/blob URLs (no canvas extraction)
    // -------------------------------------------------------------
    if (hasDataOrBlobUrl) {
    try {
        showToast("AI Image Guard", "Processing image...", "info");
        
        const imgSrc = bestUrl || img.src || img.currentSrc;
      let dataUrl = null;
        
        // For data URLs, use them directly (they're already base64 encoded)
        if (imgSrc && imgSrc.startsWith('data:')) {
          dataUrl = imgSrc;
          console.log("[AI Image Guard Debug] Using data URL directly:", {
            source: imgSrc.substring(0, 100),
            dataUrlLength: imgSrc.length
          });
        }
        // For blob URLs, fetch and convert
        else if (imgSrc && imgSrc.startsWith('blob:')) {
        try {
          const response = await fetch(imgSrc);
          if (response.ok) {
            const blob = await response.blob();
              // Convert blob to data URL using FileReader
            dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
              console.log("[AI Image Guard Debug] Blob URL fetched successfully:", {
              source: imgSrc.substring(0, 100),
              blobSize: blob.size,
              blobType: blob.type
            });
            } else {
              throw new Error(`Blob fetch ${response.status}`);
          }
        } catch (fetchErr) {
            console.error("Blob URL fetch failed:", fetchErr);
            showToast("Analysis error", `Could not fetch blob URL: ${fetchErr.message}`, "error");
            return;
          }
        }

        if (!dataUrl) {
          throw new Error("No data URL available");
        }

        showToast("AI Image Guard", "Analyzing image...", "info");

        // Track the original image URL for logging
        const originalImageUrl = bestUrl || img.src || img.currentSrc || null;

      const resp = await sendMessageSafely({
        action: "analyzeImage",
        imageData: dataUrl,
          imageSource: originalImageUrl,
        source: "click-to-detect",
        user_action: "On-click detect",
        detection_type: "On-click detect"
      });

      renderResultToast(resp?.result || resp);
      return;
    } catch (err) {
        console.error("Data/blob URL processing failed:", err);
        showToast("Analysis error", `Could not process image: ${err.message}`, "error");
        return;
      }
    }

    // No URL available and no canvas extraction - show error
    console.error("No valid image source available and canvas extraction is disabled");
    showToast("Analysis error", "No valid image source available. Please use right-click detection for this image.", "error");

  } catch (err) {
    console.error("On-click detect error:", err);
  }
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
      toast.style.cssText = `display:flex;align-items:start;gap:12px;padding:12px 14px;max-width:360px;background:${v[1]};color:${v[2]};border-left:4px solid ${v[0]};border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,0.35);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;transition:opacity .18s ease-out,transform .18s ease-out;opacity:0;transform:translateY(-8px) scale(1);`;
      const content = document.createElement('div');
      const t = document.createElement('div'); t.textContent = title || 'AI Image Guard'; t.style.cssText = 'font-weight:600;letter-spacing:.2px;margin-bottom:2px;';
      const m = document.createElement('div'); m.textContent = message || ''; m.style.cssText = 'opacity:.9;line-height:1.35;white-space:pre-line;';
      content.appendChild(t); content.appendChild(m);
      const closeBtn = document.createElement('button'); closeBtn.textContent = '✕'; closeBtn.setAttribute('aria-label','Close notification'); closeBtn.style.cssText = 'margin-left:auto;background:transparent;border:none;color:inherit;cursor:pointer;font-size:14px;padding:2px;opacity:.7;';
      const removeToast = () => { if (toast.parentNode) toast.parentNode.removeChild(toast); };
      closeBtn.onclick = removeToast;
      toast.onclick = removeToast;
      toast.appendChild(content); toast.appendChild(closeBtn); container.appendChild(toast);
      requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0) scale(1)'; });
      const timeoutMs = type === 'warning' ? 8000 : 5000;
      let hideTimer = setTimeout(removeToast, timeoutMs);
      if (type === 'warning' || type === 'success') {
        toast.addEventListener('mouseenter', () => {
          toast.style.transform = 'translateY(0) scale(1.05)';
          if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        });
        toast.addEventListener('mouseleave', () => {
          toast.style.transform = 'translateY(0) scale(1)';
          if (!hideTimer) { hideTimer = setTimeout(removeToast, timeoutMs); }
        });
      }
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
