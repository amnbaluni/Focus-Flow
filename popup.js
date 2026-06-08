/**
 * FocusFlow Popup Logic
 * Handles toggle UI, messaging with service worker, stats display, and settings sliders
 */

// ============================================
// DOM ELEMENTS
// ============================================

const elements = {
  toggle: document.getElementById('enable-toggle'),
  statusBadge: document.getElementById('status-badge'),
  cameraStatus: document.getElementById('camera-status'),
  errorMessage: document.getElementById('error-message'),
  // Stats (Phase 02)
  pauseCount: document.getElementById('pause-count'),
  timeSaved: document.getElementById('time-saved'),
  resetBtn: document.getElementById('reset-stats-btn'),
  // Settings sliders (Phase 02)
  gracePeriod: document.getElementById('grace-period'),
  gracePeriodValue: document.getElementById('grace-period-value'),
  yawThreshold: document.getElementById('yaw-threshold'),
  yawThresholdValue: document.getElementById('yaw-threshold-value'),
  pitchThreshold: document.getElementById('pitch-threshold'),
  pitchThresholdValue: document.getElementById('pitch-threshold-value'),
  studyModeToggle: document.getElementById('study-mode-toggle')
};

// ============================================
// STATE
// ============================================

let currentState = 'disabled';
let currentTabId = null;
let settingsDebounceTimer = null;
let studyModeEnabled = false;

// ============================================
// INITIALIZATION
// ============================================

async function init() {
  try {
    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      showError('No active tab');
      return;
    }

    currentTabId = tab.id;

    // Load current state for this tab
    await loadState();

    // Load stats
    await loadStats();

    // Load settings
    await loadSettings();

    // Load Study Mode state
    await loadStudyModeState();

    // Set up event listeners
    elements.toggle.addEventListener('change', handleToggleChange);

    // Study Mode toggle
    if (elements.studyModeToggle) {
      elements.studyModeToggle.addEventListener('change', handleStudyModeToggle);
    }
    
    // Direct enable button for debugging
    const enableBtn = document.getElementById('enable-btn');
    if (enableBtn) {
      enableBtn.addEventListener('click', () => {
        enableExtension();
      });
    }

    // Stats reset
    if (elements.resetBtn) {
      elements.resetBtn.addEventListener('click', handleResetStats);
    }

    // Settings sliders with debounce
    if (elements.gracePeriod) {
      elements.gracePeriod.addEventListener('input', handleSliderChange);
    }
    if (elements.yawThreshold) {
      elements.yawThreshold.addEventListener('input', handleSliderChange);
    }
    if (elements.pitchThreshold) {
      elements.pitchThreshold.addEventListener('input', handleSliderChange);
    }

  } catch (err) {
    console.error('[FocusFlow Popup] init error:', err);
  }
}

// ============================================
// STATE MANAGEMENT
// ============================================

async function loadState() {
  try {
    const response = await sendMessage({
      type: 'GET_STATE',
      payload: { tabId: currentTabId }
    });

    if (response.success) {
      currentState = response.state;
      updateUI();
    }
  } catch (error) {
    console.error('[FocusFlow] Failed to load state:', error);
  }
}

async function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ============================================
// STATS MANAGEMENT (Phase 02)
// ============================================

async function loadStats() {
  try {
    const response = await sendMessage({ type: 'GET_STATS' });

    if (response.success && elements.pauseCount && elements.timeSaved) {
      elements.pauseCount.textContent = response.pausesToday || 0;
      elements.timeSaved.textContent = `${response.timeSavedMin || 0} min`;
    }
  } catch (error) {
    console.error('[FocusFlow] Failed to load stats:', error);
  }
}

async function handleResetStats() {
  try {
    const response = await sendMessage({ type: 'RESET_STATS' });

    if (response.success) {
      if (elements.pauseCount && elements.timeSaved) {
        elements.pauseCount.textContent = '0';
        elements.timeSaved.textContent = '0 min';
      }
    }
  } catch (error) {
    console.error('[FocusFlow] Failed to reset stats:', error);
  }
}

// ============================================
// SETTINGS MANAGEMENT (Phase 02)
// ============================================

async function loadSettings() {
  try {
    const response = await sendMessage({ type: 'GET_SETTINGS' });

    if (response.success && response.settings) {
      updateSettingsUI(response.settings);
    }
  } catch (error) {
    console.error('[FocusFlow] Failed to load settings:', error);
  }
}

function updateSettingsUI(settings) {
  if (elements.gracePeriod && elements.gracePeriodValue) {
    const gracePeriod = settings.gracePeriod || 5;
    elements.gracePeriod.value = gracePeriod;
    elements.gracePeriodValue.textContent = `${gracePeriod}s`;
  }

  if (elements.yawThreshold && elements.yawThresholdValue) {
    const yaw = settings.yawThreshold || 30;
    elements.yawThreshold.value = yaw;
    elements.yawThresholdValue.textContent = `${yaw}°`;
  }

  if (elements.pitchThreshold && elements.pitchThresholdValue) {
    const pitch = settings.pitchThreshold || 25;
    elements.pitchThreshold.value = pitch;
    elements.pitchThresholdValue.textContent = `${pitch}°`;
  }
}

function handleSliderChange(event) {
  // Debounce slider changes
  if (settingsDebounceTimer) {
    clearTimeout(settingsDebounceTimer);
  }

  settingsDebounceTimer = setTimeout(() => {
    saveSettings();
  }, 300);

  // Update display immediately
  updateSliderDisplay(event.target);
}

function updateSliderDisplay(slider) {
  if (slider.id === 'grace-period' && elements.gracePeriodValue) {
    elements.gracePeriodValue.textContent = `${slider.value}s`;
  } else if (slider.id === 'yaw-threshold' && elements.yawThresholdValue) {
    elements.yawThresholdValue.textContent = `${slider.value}°`;
  } else if (slider.id === 'pitch-threshold' && elements.pitchThresholdValue) {
    elements.pitchThresholdValue.textContent = `${slider.value}°`;
  }
}

async function saveSettings() {
  const newSettings = {
    gracePeriod: parseInt(elements.gracePeriod?.value || 5),
    yawThreshold: parseInt(elements.yawThreshold?.value || 30),
    pitchThreshold: parseInt(elements.pitchThreshold?.value || 25)
  };

  try {
    await sendMessage({
      type: 'UPDATE_SETTINGS',
      payload: newSettings
    });
  } catch (error) {
    console.error('[FocusFlow] Failed to save settings:', error);
  }
}

// ============================================
// TOGGLE HANDLER
// ============================================

async function handleToggleChange(event) {
  const enabled = event.target.checked;
  
  if (enabled) {
    await enableExtension();
  } else {
    await disableExtension();
  }
}

async function enableExtension() {
  try {
    // Get current tab URL (not popup URL) for YouTube video check
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const videoUrl = tab?.url || tab?.href;
    
    const response = await sendMessage({
      type: 'ENABLE',
      payload: {
        requestCamera: true,
        videoUrl: videoUrl,
        tabId: tab.id
      }
    });
    
    if (response.success) {
      currentState = response.state;
      updateUI();

      if (response.videoDisabled) {
        showError('FocusFlow is disabled for this video');
        elements.toggle.checked = false;
        currentState = 'disabled';
        updateUI();
      }
    } else {
      console.error('[FocusFlow] Enable failed:', response.error);
      showError(response.error);
      elements.toggle.checked = false;
    }
  } catch (error) {
    console.error('[FocusFlow] Enable error:', error);
    showError('Failed to enable extension');
    elements.toggle.checked = false;
  }
}

async function disableExtension() {
  try {
    const response = await sendMessage({
      type: 'DISABLE',
      payload: { tabId: currentTabId }
    });

    if (response.success) {
      currentState = response.state;
      updateUI();
      hideError();
    } else {
      console.error('[FocusFlow Popup] DISABLE failed:', response.error);
    }
  } catch (error) {
    console.error('[FocusFlow Popup] Disable error:', error);
  }
}

// ============================================
// UI UPDATES
// ============================================

function updateUI() {
  if (currentState === 'enabled') {
    elements.statusBadge.textContent = 'Active';
    elements.statusBadge.classList.remove('inactive');
    elements.statusBadge.classList.add('active');
    elements.toggle.checked = true;
  } else {
    elements.statusBadge.textContent = 'Inactive';
    elements.statusBadge.classList.remove('active');
    elements.statusBadge.classList.add('inactive');
    elements.toggle.checked = false;
  }
  updateStudyModeUI();
}

async function loadStudyModeState() {
  try {
    const response = await sendMessage({ type: 'GET_STUDY_MODE_STATE', payload: { tabId: currentTabId } });
    if (response.success) {
      studyModeEnabled = response.enabled;
      updateStudyModeUI();
    }
  } catch (error) {
    console.error('[FocusFlow] Failed to load Study Mode state:', error);
  }
}

async function handleStudyModeToggle(event) {
  const enabled = event.target.checked;
  try {
    const response = await sendMessage({
      type: 'STUDY_MODE_TOGGLE',
      payload: { enabled, tabId: currentTabId }
    });
    if (response.success) {
      studyModeEnabled = enabled;
      updateStudyModeUI();
    } else {
      elements.studyModeToggle.checked = !enabled;
      console.error('[FocusFlow] Study Mode toggle failed:', response.error);
    }
  } catch (error) {
    elements.studyModeToggle.checked = !enabled;
    console.error('[FocusFlow] Study Mode toggle error:', error);
  }
}

function updateStudyModeUI() {
  if (elements.studyModeToggle) {
    elements.studyModeToggle.checked = studyModeEnabled;
  }
}

function showCameraActive() {
  elements.cameraStatus.classList.remove('hidden');
}

function hideCameraActive() {
  elements.cameraStatus.classList.add('hidden');
}

function showError(message) {
  elements.errorMessage.querySelector('p').textContent = message || 'Camera access denied';
  elements.errorMessage.classList.remove('hidden');
}

function hideError() {
  elements.errorMessage.classList.add('hidden');
}

// ============================================
// INITIALIZE ON LOAD
// ============================================

document.addEventListener('DOMContentLoaded', init);