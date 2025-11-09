// content-main.js — Main content script for the image cropper
(() => {
  // Track if extension context is still valid
  let isExtensionContextValid = true;
  
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

  // Handle messages from the background script
  function onRuntimeMessage(request, sender, sendResponse) {
    if (request && request.action === "detectImage" && request.imageUrl) {
      showCropper(request.imageUrl);
    }
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  // Handle window messages (e.g., from context menu)
  function onWindowMessage(event) {
    if (event.source === window && event.data && event.data.type === "START_CROPPING" && event.data.imageUrl) {
      showCropper(event.data.imageUrl);
    }
  }
  window.addEventListener("message", onWindowMessage);

  // Show the cropper UI
  async function showCropper(imageUrl) {
    const existing = document.getElementById("ai-detector-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "ai-detector-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      backgroundColor: "rgba(0,0,0,0.8)",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      zIndex: 2147483647,
      flexDirection: "column",
      padding: "12px"
    });

    const card = document.createElement("div");
    Object.assign(card.style, {
      background: "#111",
      padding: "12px",
      borderRadius: "8px",
      maxWidth: "90vw",
      maxHeight: "90vh",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "10px"
    });

    const img = document.createElement("img");
    img.id = "image-to-crop";
    img.alt = "Image to crop for deepfake detection";
    img.style.maxWidth = "80vw";
    img.style.maxHeight = "60vh";
    img.style.border = "3px solid white";
    img.style.objectFit = "contain";
    img.style.display = "none";

    const loader = document.createElement("div");
    loader.innerText = "⏳ Loading image...";
    loader.style.color = "#fff";

    const errText = document.createElement("div");
    errText.style.color = "#f88";
    errText.style.display = "none";

    const btnContainer = document.createElement("div");
    Object.assign(btnContainer.style, { marginTop: "6px", display: "flex", gap: "8px" });

    const cropBtn = document.createElement("button");
    cropBtn.innerText = "Crop & Detect";
    Object.assign(cropBtn.style, {
      padding: "8px 14px",
      border: "none",
      borderRadius: "6px",
      cursor: "pointer",
      background: "#4CAF50",
      color: "#fff"
    });
    cropBtn.disabled = true;

    const fallbackBtn = document.createElement("button");
    fallbackBtn.innerText = "Classify Original Image (No Crop)";
    Object.assign(fallbackBtn.style, {
      padding: "8px 14px",
      border: "none",
      borderRadius: "6px",
      cursor: "pointer",
      background: "#1976d2",
      color: "#fff"
    });
    fallbackBtn.disabled = true;

    const cancelBtn = document.createElement("button");
    cancelBtn.innerText = "Cancel";
    Object.assign(cancelBtn.style, {
      padding: "8px 14px",
      border: "none",
      borderRadius: "6px",
      cursor: "pointer",
      background: "#f44336",
      color: "#fff"
    });

    btnContainer.appendChild(cropBtn);
    btnContainer.appendChild(fallbackBtn);
    btnContainer.appendChild(cancelBtn);

    card.appendChild(loader);
    card.appendChild(img);
    card.appendChild(errText);
    card.appendChild(btnContainer);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    cancelBtn.focus();

    function closeOverlay() {
      try { 
        if (cropper) {
          cropper.destroy();
          cropper = null;
        }
      } catch (e) {
        console.warn("Error cleaning up cropper:", e);
      }
      
      window.removeEventListener("keydown", onKeyDown);
      
      if (document.body.contains(overlay)) {
        overlay.remove();
      }
      
      if (img && img.src && img.src.startsWith('blob:')) {
        try { URL.revokeObjectURL(img.src); } catch (e) {}
      }
    }

    function onKeyDown(e) { 
      if (e.key === "Escape") closeOverlay(); 
    }
    
    window.addEventListener("keydown", onKeyDown);
    overlay.addEventListener("click", (ev) => { 
      if (ev.target === overlay) closeOverlay(); 
    });

    let cropper = null;

    function showError(msg) {
      loader.style.display = "none";
      errText.style.display = "block";
      errText.innerText = msg;
      cropBtn.disabled = true;
      fallbackBtn.disabled = false;
    }

    // Load the image
    try {
      const resp = await fetch(imageUrl, { mode: 'cors' });
      if (!resp.ok) throw new Error(`Failed to fetch image: ${resp.status}`);
      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);
      img.src = objectUrl;
    } catch (fetchErr) {
      console.warn("Fetch failed or CORS blocked, trying direct image element src:", fetchErr);
      try {
        img.crossOrigin = "anonymous";
        img.src = imageUrl;
      } catch (e) {
        console.error("Direct src assign failed:", e);
        showError("Unable to load image for cropping.");
        fallbackBtn.disabled = false;
      }
    }

    img.addEventListener("load", () => {
      loader.style.display = "none";
      img.style.display = "block";
      cropBtn.disabled = false;
      fallbackBtn.disabled = false;
      
      try {
        cropper = new Cropper(img, {
          aspectRatio: 1,
          viewMode: 1,
          guides: true,
          dragMode: "move",
          zoomable: true,
          background: false
        });
      } catch (e) {
        console.error("Cropper init failed:", e);
        showError("Cropper failed to initialize.");
      }
    });

    img.addEventListener("error", (e) => {
      console.error("Image load error", e);
      showError("Failed to load image. The image may be blocked or missing.");
    });

    cancelBtn.addEventListener("click", () => { closeOverlay(); });

    fallbackBtn.addEventListener("click", async () => {
      showMinimalProcessingState();
      try {
        await sendMessageSafely({ action: "classifyUrl", url: imageUrl });
        closeOverlay();
      } catch (err) {
        console.error("Fallback classifyUrl message failed:", err);
        showError(err.message || "Fallback classification failed. Please try again.");
      }
    });

    cropBtn.addEventListener("click", async () => {
      if (!cropper) {
        showError("Cropper is not ready.");
        return;
      }
      
      showMinimalProcessingState();
      
      try {
        const croppedCanvas = cropper.getCroppedCanvas({ width: 256, height: 256 });
        let dataUrl;
        
        try {
          dataUrl = croppedCanvas.toDataURL("image/jpeg", 0.92);
          
          // Send the cropped image data to the background script
          await sendMessageSafely({ 
            action: "croppedImageReady", 
            dataUrl,
            source: "content-main"
          });
          
          closeOverlay();
        } catch (e) {
          console.warn("toDataURL failed (likely cross-origin / tainted canvas):", e);
          try {
            await sendMessageSafely({ 
              action: "classifyUrl", 
              url: imageUrl,
              source: "content-main"
            });
          } catch (err) {
            console.error("Fallback classification failed:", err);
            showError(err.message || "Failed to classify image");
          } finally {
            closeOverlay();
          }
        }
      } catch (err) {
        console.error("Crop & detect error:", err);
        showError("Failed to process the image. Try a different area or use the fallback.");
      }
    });

    function showMinimalProcessingState() {
      loader.style.display = "block";
      loader.innerText = "⏳ Sending for analysis...";
      cropBtn.disabled = true;
      fallbackBtn.disabled = true;
      cancelBtn.disabled = true;
    }
  }

  console.log("Content script (main) loaded");
  
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
      const m = document.createElement('div'); m.textContent = message || ''; m.style.cssText = 'opacity:.9;line-height:1.35;';
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
})();
