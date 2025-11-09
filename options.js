// options.js — simple settings manager for backend URL

// Default settings
const DEFAULT_SETTINGS = {
  // General
  realTimeScanning: true,
  scanInterval: 3, // seconds
  showNotifications: true,
  serverUrl: 'http://127.0.0.1:8000',
  
  // Models
  useViT: true,
  useEfficientNet: true,
  detectionThreshold: 70, // percentage
  modelPriority: 'ensemble', // 'ensemble', 'vit', or 'efficientnet'
  
  // Appearance
  showBadges: true,
  highlightFaces: true,
  badgePosition: 'top-right',
  badgeStyle: 'modern',
  
  // Advanced
  debugMode: false,
  lastUpdated: new Date().toISOString()
};

// DOM Elements
const elements = {
  // Form
  form: document.getElementById('settingsForm'),
  status: document.getElementById('status'),
  
  // General Tab
  realTimeScanning: document.getElementById('realTimeScanning'),
  scanInterval: document.getElementById('scanInterval'),
  scanIntervalValue: document.getElementById('scanIntervalValue'),
  showNotifications: document.getElementById('showNotifications'),
  serverUrl: document.getElementById('serverUrl'),
  testConnection: document.getElementById('testConnection'),
  serverStatus: document.getElementById('serverStatus'),
  
  // Models Tab
  useViT: document.getElementById('useViT'),
  useEfficientNet: document.getElementById('useEfficientNet'),
  detectionThreshold: document.getElementById('detectionThreshold'),
  thresholdValue: document.getElementById('thresholdValue'),
  modelPriority: document.getElementById('modelPriority'),
  
  // Appearance Tab
  showBadges: document.getElementById('showBadges'),
  highlightFaces: document.getElementById('highlightFaces'),
  badgePosition: document.getElementById('badgePosition'),
  badgeStyle: document.getElementById('badgeStyle'),
  
  // Buttons
  resetBtn: document.getElementById('resetBtn'),
  saveBtn: document.querySelector('button[type="submit"]')
};

// Tab functionality
function setupTabs() {
  const tabLinks = document.querySelectorAll('.tab-link');
  
  tabLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      
      // Remove active class from all tabs and links
      document.querySelectorAll('.tab-link').forEach(l => l.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      
      // Add active class to clicked tab
      link.classList.add('active');
      const tabId = link.getAttribute('data-tab');
      document.getElementById(tabId).classList.add('active');
    });
  });
}

// Slider value display
function setupSliders() {
  // Scan interval slider
  elements.scanInterval.addEventListener('input', (e) => {
    elements.scanIntervalValue.textContent = e.target.value;
  });
  
  // Detection threshold slider
  elements.detectionThreshold.addEventListener('input', (e) => {
    elements.thresholdValue.textContent = e.target.value;
  });
}

// Test server connection
async function testServerConnection() {
  const serverUrl = elements.serverUrl.value || DEFAULT_SETTINGS.serverUrl;
  
  if (!serverUrl) {
    showStatus('Please enter a valid server URL', 'error');
    return;
  }
  
  // Show loading state
  elements.testConnection.disabled = true;
  elements.testConnection.textContent = 'Testing...';
  elements.serverStatus.className = 'server-status';
  
  try {
    // Test the server connection with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(`${serverUrl}/health`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }
    
    const data = await response.json();
    
    // Update UI based on server status
    if (data.status === 'ok') {
      elements.serverStatus.className = 'server-status online';
      const modelInfo = [
        data.vit_loaded && 'ViT',
        data.efficientnet_loaded && 'EfficientNet'
      ].filter(Boolean).join(' + ') || 'No models loaded';
      
      showStatus(
        `✅ Connected to server! Models: ${modelInfo} (${data.device})`,
        'success'
      );
    } else {
      throw new Error('Server is not ready');
    }
  } catch (error) {
    console.error('Connection test failed:', error);
    elements.serverStatus.className = 'server-status offline';
    
    let errorMessage = error.message;
    if (error.name === 'AbortError') {
      errorMessage = 'Connection timed out. Is the server running?';
    } else if (error.message.includes('Failed to fetch')) {
      errorMessage = 'Failed to connect to server. Check the URL and try again.';
    }
    
    showStatus(`❌ ${errorMessage}`, 'error');
  } finally {
    elements.testConnection.disabled = false;
    elements.testConnection.textContent = 'Test Connection';
  }
}

// Save settings to chrome.storage
function saveOptions(e) {
  if (e) e.preventDefault();
  
  const settings = {
    // General
    realTimeScanning: elements.realTimeScanning.checked,
    scanInterval: parseInt(elements.scanInterval.value),
    showNotifications: elements.showNotifications.checked,
    serverUrl: elements.serverUrl.value,
    
    // Models
    useViT: elements.useViT.checked,
    useEfficientNet: elements.useEfficientNet.checked,
    detectionThreshold: parseInt(elements.detectionThreshold.value) / 100, // Convert to 0-1 range
    modelPriority: elements.modelPriority.value,
    
    // Appearance
    showBadges: elements.showBadges.checked,
    highlightFaces: elements.highlightFaces.checked,
    badgePosition: elements.badgePosition.value,
    badgeStyle: elements.badgeStyle.value,
    
    // Metadata
    lastUpdated: new Date().toISOString()
  };
  
  // Save to chrome.storage
  chrome.storage.sync.set(settings, () => {
    showStatus('Settings saved successfully!', 'success');
    
    // Notify other parts of the extension about the settings change
    chrome.runtime.sendMessage({ type: 'settingsUpdated', settings });
  });
}

// Load settings from chrome.storage
function restoreOptions() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    // General Tab
    elements.realTimeScanning.checked = settings.realTimeScanning;
    elements.scanInterval.value = settings.scanInterval;
    elements.scanIntervalValue.textContent = settings.scanInterval;
    elements.showNotifications.checked = settings.showNotifications;
    elements.serverUrl.value = settings.serverUrl;
    
    // Models Tab
    elements.useViT.checked = settings.useViT;
    elements.useEfficientNet.checked = settings.useEfficientNet;
    elements.detectionThreshold.value = Math.round(settings.detectionThreshold * 100); // Convert to percentage
    elements.thresholdValue.textContent = Math.round(settings.detectionThreshold * 100);
    elements.modelPriority.value = settings.modelPriority || 'ensemble';
    
    // Appearance Tab
    elements.showBadges.checked = settings.showBadges;
    elements.highlightFaces.checked = settings.highlightFaces;
    elements.badgePosition.value = settings.badgePosition || 'top-right';
    elements.badgeStyle.value = settings.badgeStyle || 'modern';
    
    // Test connection to show initial status
    testServerConnection();
  });
}

// Reset settings to defaults
function resetToDefaults() {
  if (confirm('Are you sure you want to reset all settings to their default values?')) {
    chrome.storage.sync.set(DEFAULT_SETTINGS, () => {
      restoreOptions();
      showStatus('Settings reset to defaults!', 'success');
    });
  }
}

// Show status message
function showStatus(message, type = 'info') {
  elements.status.textContent = message;
  elements.status.className = `status ${type}`;
  elements.status.style.display = 'block';
  
  // Auto-hide after 3 seconds
  setTimeout(() => {
    elements.status.style.display = 'none';
  }, 3000);
}

// Initialize the options page
document.addEventListener('DOMContentLoaded', () => {
  // Setup UI components
  setupTabs();
  setupSliders();
  
  // Load saved settings
  restoreOptions();
  
  // Event listeners
  elements.testConnection.addEventListener('click', testServerConnection);
  elements.form.addEventListener('submit', saveOptions);
  elements.resetBtn.addEventListener('click', resetToDefaults);
  
  // Support link
  document.getElementById('supportLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://github.com/yourusername/ai-image-guard/issues' });
  });
  
  // Validate model selection
  function validateModelSelection() {
    if (!elements.useViT.checked && !elements.useEfficientNet.checked) {
      elements.useViT.checked = true;
      showStatus('At least one model must be enabled', 'warning');
    }
  }
  
  elements.useViT.addEventListener('change', validateModelSelection);
  elements.useEfficientNet.addEventListener('change', validateModelSelection);
});
