// Cache for storing detection results
const detectionCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
    // Generate cache key from the image data
    const cacheKey = await generateHash(imageData);
    const cached = detectionCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
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
    const response = await fetch('http://127.0.0.1:8000/classify/file', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('API Error:', { status: response.status, statusText: response.statusText, error });
      throw new Error(`API Error: ${response.status} ${response.statusText} - ${error}`);
    }

    const result = await response.json();
    console.log('Detection result:', result);
    
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