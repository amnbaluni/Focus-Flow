/**
 * FocusFlow Service Worker
 * Orchestrates message passing between popup and content script
 * Manages per-tab state and settings persistence
 */

// ============================================
// HELPER: Send message to content script
// ============================================

/**
 * Send a message to the content script on a given tab.
 * Returns true if the message was delivered successfully.
 */
async function sendMessageToContentScript(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    return false;
  }
}

// ============================================
// STATE MANAGEMENT
// ============================================

/**
 * Get the enabled state for a specific tab
 * @param {number} tabId - Chrome tab ID
 * @returns {Promise<boolean>}
 */
async function getTabEnabledState(tabId) {
  const storage = await chrome.storage.local.get(`tab_${tabId}_enabled`);
  return storage[`tab_${tabId}_enabled`] || false;
}

/**
 * Set the enabled state for a specific tab
 * @param {number} tabId - Chrome tab ID
 * @param {boolean} enabled - Whether extension is enabled for this tab
 */
async function setTabEnabledState(tabId, enabled) {
  await chrome.storage.local.set({
    [`tab_${tabId}_enabled`]: enabled,
    [`tab_${tabId}_enabled_at`]: Date.now()
  });
}

async function getTabStudyModeState(tabId) {
  const storage = await chrome.storage.local.get(`tab_${tabId}_studyMode`);
  return storage[`tab_${tabId}_studyMode`] || false;
}

async function setTabStudyModeState(tabId, enabled) {
  await chrome.storage.local.set({
    [`tab_${tabId}_studyMode`]: enabled,
    [`tab_${tabId}_studyMode_at`]: Date.now()
  });
}

// ============================================
// DEFAULT SETTINGS
// ============================================

const DEFAULT_SETTINGS = {
  gracePeriod: 5,           // seconds before pausing
  frameRate: 10,           // fps for detection
  yawThreshold: 30,        // degrees
  pitchThreshold: 25,       // degrees
  eyeOpennessThreshold: 0.2,
  faceConfidenceThreshold: 0.6
};

/**
 * Get settings from sync storage or defaults
 * @returns {Promise<object>}
 */
async function getSettings() {
  const stored = await chrome.storage.sync.get('settings');
  if (stored.settings) {
    return { ...DEFAULT_SETTINGS, ...stored.settings };
  }
  // Initialize with defaults
  await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  return DEFAULT_SETTINGS;
}

// ============================================
// STATS MANAGEMENT (Phase 02)
// ============================================

const DEFAULT_STATS = {
  pausesToday: 0,
  timeSavedMs: 0,
  lastResetDate: null
};

/**
 * Get stats from local storage
 * @returns {Promise<object>}
 */
async function getStats() {
  const stored = await chrome.storage.local.get('stats');
  let stats = stored.stats || { ...DEFAULT_STATS };
  
  // Check for daily reset
  const today = new Date().toDateString();
  if (stats.lastResetDate !== today) {
    // New day - reset stats
    stats = { ...DEFAULT_STATS, lastResetDate: today };
    await chrome.storage.local.set({ stats });
  }
  
  return stats;
}

/**
 * Increment pause count
 */
async function incrementPause() {
  const stats = await getStats();
  stats.pausesToday += 1;
  await chrome.storage.local.set({ stats });
  return stats;
}

/**
 * Add time saved (on resume)
 * @param {number} ms - Duration in milliseconds
 */
async function addTimeSaved(ms) {
  const stats = await getStats();
  stats.timeSavedMs += ms;
  await chrome.storage.local.set({ stats });
  return stats;
}

/**
 * Reset stats manually
 */
async function resetStats() {
  const stats = { ...DEFAULT_STATS, lastResetDate: new Date().toDateString() };
  await chrome.storage.local.set({ stats });
  return stats;
}

// ============================================
// PER-VIDEO DISABLE MANAGEMENT (Phase 02)
// ============================================

/**
 * Get disabled videos list
 * @returns {Promise<string[]>}
 */
async function getDisabledVideos() {
  const stored = await chrome.storage.local.get('disabledVideos');
  return stored.disabledVideos || [];
}

/**
 * Check if video is disabled
 * @param {string} videoUrl - Video URL to check
 * @returns {Promise<boolean>}
 */
async function isVideoDisabled(videoUrl) {
  const disabled = await getDisabledVideos();
  return disabled.includes(videoUrl);
}

/**
 * Disable video for current session
 * @param {string} videoUrl - Video URL to disable
 */
async function disableVideo(videoUrl) {
  const disabled = await getDisabledVideos();
  if (!disabled.includes(videoUrl)) {
    disabled.push(videoUrl);
    await chrome.storage.local.set({ disabledVideos: disabled });
  }
  return disabled;
}

/**
 * Enable video
 * @param {string} videoUrl - Video URL to enable
 */
async function enableVideo(videoUrl) {
  const disabled = await getDisabledVideos();
  const filtered = disabled.filter(url => url !== videoUrl);
  await chrome.storage.local.set({ disabledVideos: filtered });
  return filtered;
}

// ============================================
// CONTEXT MENU (Phase 02)
// ============================================

function createContextMenu() {
  chrome.contextMenus.create({
    id: 'focusflow-toggle',
    title: 'Toggle FocusFlow',
    contexts: ['page']
  });
  
  chrome.contextMenus.create({
    id: 'focusflow-disable-video',
    title: 'Disable FocusFlow for this video',
    contexts: ['page']
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'focusflow-toggle') {
    const currentState = await getTabEnabledState(tab.id);
    if (currentState) {
      await handleDisable(tab.id);
    } else {
      await handleEnable(tab.id);
    }
  } else if (info.menuItemId === 'focusflow-disable-video') {
    // Get current YouTube URL
    const url = tab.url;
    if (url && url.includes('youtube.com')) {
      await disableVideo(url);
    }
  }
});

// ============================================
// MESSAGE HANDLERS
// ============================================

/**
 * Handle messages from popup and content script
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then((result) => {
    sendResponse(result);
  });
  return true; // Indicates async response
});

async function handleMessage(message, sender) {
  const { type, payload } = message;

  switch (type) {
    case 'ENABLE':
      return await handleEnable(payload?.tabId, payload);

    case 'DISABLE':
      return await handleDisable(payload?.tabId);

    case 'GET_STATE':
      return await handleGetState(payload?.tabId || sender.tab?.id);

    case 'UPDATE_SETTINGS':
      return await handleUpdateSettings(payload);

    case 'GET_SETTINGS':
      return await handleGetSettings();

    case 'CONTENT_STATE_UPDATE':
      return await handleContentStateUpdate(sender.tab?.id, payload);

    case 'DISABLE_FOR_VIDEO':
      return await handleDisableForVideo(payload, sender);

    case 'CAMERA_ERROR':
      return await handleCameraError(payload);

    // Phase 02 message handlers
    case 'GET_STATS':
      return await handleGetStats();

    case 'REPORT_PAUSE':
      return await handleReportPause();

    case 'REPORT_RESUME':
      return await handleReportResume(payload?.pauseDuration);

    case 'RESET_STATS':
      return await handleResetStats();

    case 'CHECK_VIDEO_DISABLED':
      return await handleCheckVideoDisabled(payload?.url);

    case 'DISABLE_CURRENT_VIDEO':
      return await handleDisableCurrentVideo(payload?.url);

    case 'STUDY_MODE_TOGGLE':
      return await handleStudyModeToggle(payload?.tabId, payload?.enabled);

    case 'GET_STUDY_MODE_STATE':
      return await handleGetStudyModeState(payload?.tabId || sender.tab?.id);

    default:
      console.warn('[FocusFlow] Unknown message type:', type);
      return { success: false, error: 'Unknown message type' };
  }
}

async function handleEnable(tabId, payload) {
  if (!tabId) {
    return { success: false, error: 'No tab ID' };
  }

  // Check if video is disabled
  const videoUrl = payload?.videoUrl;
  if (videoUrl) {
    const disabled = await isVideoDisabled(videoUrl);
    if (disabled) {
      return { success: false, error: 'Video disabled', videoDisabled: true };
    }
  }

  await setTabEnabledState(tabId, true);
  
  // Notify content script to start detection
  const sent = await sendMessageToContentScript(tabId, {
    type: 'START_DETECTION',
    payload: payload || {}
  });

  if (sent) {
    return { success: true, state: 'enabled' };
  }

  // Content script not found — inject it dynamically
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url?.includes('youtube.com')) {
      return { success: true, state: 'enabled', note: 'Not a YouTube page' };
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['overlay.js', 'content.js']
    });
    await chrome.tabs.sendMessage(tabId, {
      type: 'START_DETECTION',
      payload: payload || {}
    });
    return { success: true, state: 'enabled' };
  } catch (injectError) {
    return { success: true, state: 'enabled', note: 'Content script not ready' };
  }
}

async function handleDisable(tabId) {
  if (!tabId) {
    return { success: false, error: 'No tab ID' };
  }

  await setTabEnabledState(tabId, false);
  
  // Notify content script to stop detection
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'STOP_DETECTION'
    });
    
  } catch (error) {
    console.log('[FocusFlow Background] STOP_DETECTION failed:', error.message);
  }

  return { success: true, state: 'disabled' };
}

async function handleGetState(tabId) {
  if (!tabId) {
    return { success: false, error: 'No tab ID' };
  }

  const enabled = await getTabEnabledState(tabId);
  return {
    success: true,
    state: enabled ? 'enabled' : 'disabled',
    tabId
  };
}

async function handleUpdateSettings(newSettings) {
  const current = await getSettings();
  const merged = { ...current, ...newSettings };
  await chrome.storage.sync.set({ settings: merged });

  // Broadcast settings update to all tabs with content scripts
  const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://youtube.com/*'] });
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', payload: merged });
    } catch (e) {
      // Content script may not be loaded
    }
  }

  return { success: true, settings: merged };
}

async function handleGetSettings() {
  const settings = await getSettings();
  return { success: true, settings };
}

async function handleContentStateUpdate(tabId, payload) {
  if (tabId) {
    await setTabEnabledState(tabId, payload?.state === 'FOCUSED' || payload?.state === 'ENABLED');
  }
  return { success: true };
}

async function handleDisableForVideo(payload, sender) {
  const url = sender?.tab?.url;
  if (url) {
    await disableVideo(url);
  }
  return { success: true };
}

async function handleCameraError(payload) {
  console.log('[FocusFlow] Camera error:', payload.error);
  return { success: true };
}

// Phase 02 handlers
async function handleGetStats() {
  const stats = await getStats();
  return {
    success: true,
    pausesToday: stats.pausesToday,
    timeSavedMs: stats.timeSavedMs,
    timeSavedMin: Math.round(stats.timeSavedMs / 60000)
  };
}

async function handleReportPause() {
  const stats = await incrementPause();
  return { success: true, pausesToday: stats.pausesToday };
}

async function handleReportResume(pauseDuration) {
  if (pauseDuration > 0) {
    const stats = await addTimeSaved(pauseDuration);
    return { success: true, timeSavedMs: stats.timeSavedMs };
  }
  return { success: true };
}

async function handleResetStats() {
  const stats = await resetStats();
  return { success: true, stats };
}

async function handleCheckVideoDisabled(url) {
  if (!url) return { success: true, disabled: false };
  const disabled = await isVideoDisabled(url);
  return { success: true, disabled };
}

async function handleDisableCurrentVideo(url) {
  if (!url) return { success: false, error: 'No URL' };
  await disableVideo(url);
  return { success: true };
}

async function handleStudyModeToggle(tabId, enabled) {
  if (!tabId) {
    return { success: false, error: 'No tab ID' };
  }

  await setTabStudyModeState(tabId, enabled);

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'STUDY_MODE_STATE',
      payload: { enabled }
    });
  } catch (e) {
    console.log('[FocusFlow] Content script not available for Study Mode notification:', e.message);
  }

  return { success: true, enabled };
}

async function handleGetStudyModeState(tabId) {
  if (!tabId) {
    return { success: false, error: 'No tab ID', enabled: false };
  }

  const enabled = await getTabStudyModeState(tabId);
  return { success: true, enabled };
}

// ============================================
// TAB MANAGEMENT
// ============================================

/**
 * Clean up state when tab is closed
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.local.remove([
    `tab_${tabId}_enabled`,
    `tab_${tabId}_enabled_at`,
    `tab_${tabId}_studyMode`,
    `tab_${tabId}_studyMode_at`
  ]);
});

chrome.runtime.onInstalled.addListener(() => {
  createContextMenu();
});

// ============================================
// ALARM FOR PERIODIC SYNC
// ============================================

/**
 * Set up periodic alarm for state sync
 */
chrome.alarms.create('stateSync', {
  periodInMinutes: 5
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'stateSync') {
    console.log('[FocusFlow] State sync alarm');
  }
});
