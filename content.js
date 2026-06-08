(function() {
  'use strict';

  const CONFIG = {
    CAMERA_WIDTH: 192,
    CAMERA_HEIGHT: 192,
    FPS: 10,
    AD_PATTERNS: [/ads\.youtube\.com/, /doubleclick\.net/, /googlesyndication\.com/],
  };

  let videoEl = null;
  let stream = null;
  let cameraVideoEl = null;
  let videoObserver = null;
  let frameCanvas = null;
  let frameCtx = null;
  let cameraEnabled = false;
  let focusflowPaused = false;
  let state = 'DISABLED';
  let isProcessing = false;
  let uncertainTimer = null;
  let workerReady = false;
  let pendingFrames = 0;
  let workerIframe = null;
  let proxyReady = false;
  let settings = {};
  let awayStreak = 0;
  let focusedStreak = 0;
  const TRANSITION_FRAMES = 3;

  function init() {
    try {
      setupVideoDetection();
      setupServiceWorkerConnection();
      loadSettings();
    } catch (err) {
      console.error('[FocusFlow] Init error:', err);
    }
  }

  async function loadSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (response.success && response.settings) {
        settings = response.settings;
      }
    } catch (e) {
      settings = {
        gracePeriod: 5,
        yawThreshold: 30,
        pitchThreshold: 25,
        eyeOpennessThreshold: 0.2,
        faceConfidenceThreshold: 0.6
      };
    }
  }

  function setupVideoDetection() {
    findVideo();
    videoObserver = new MutationObserver(() => {
      if (!document.querySelector('video')) {
        findVideo();
      }
    });
    document.body && videoObserver.observe(document.body, { childList: true, subtree: true });
  }

  function findVideo() {
    const newVideo = document.querySelector('video');
    console.log('[FocusFlow Content] findVideo called, found video:', !!newVideo, 'current videoEl:', !!videoEl);
    if (newVideo && newVideo !== videoEl) {
      console.log('[FocusFlow Content] New video element found, setting up');
      videoEl = newVideo;
      setupVideoListeners();
      console.log('[FocusFlow Content] Video listeners set up, cameraEnabled:', cameraEnabled);
      if (cameraEnabled) {
        console.log('[FocusFlow Content] Camera enabled, starting frame loop');
        startFrameLoop();
      }
    }
  }

  function setupVideoListeners() {
    if (!videoEl) {
      console.log('[FocusFlow Content] setupVideoListeners: no video element');
      return;
    }
    console.log('[FocusFlow Content] Adding play event listener to video');
    videoEl.addEventListener('play', handleUserPlay);
  }

  function handleUserPlay() {
    console.log('[FocusFlow Content] handleUserPlay called, state:', state);
    if (state === 'AWAY') {
      console.log('[FocusFlow Content] User manually played video while AWAY, resetting state to FOCUSED');
      focusflowPaused = false;
      state = 'FOCUSED';
      notifyStateChange('FOCUSED');
      FocusFlowOverlay?.hide();
    } else {
      console.log('[FocusFlow Content] User played video but state is:', state, '(not AWAY, ignoring)');
    }
  }

  function isAdPlaying() {
    if (!videoEl) return false;
    const src = videoEl.currentSrc || '';
    const parent = videoEl.parentElement?.src || '';
    return CONFIG.AD_PATTERNS.some(p => p.test(src) || p.test(parent));
  }

  function handleProxyMessage(event) {
    if (event.source !== workerIframe?.contentWindow) return;
    const msg = event.data;
    if (msg.source !== 'focusflow-proxy') return;

    if (msg.type === 'ready') {
      console.log('[FocusFlow Content] Proxy iframe ready');
      proxyReady = true;
      workerIframe.contentWindow.postMessage({ type: 'init', config: { width: CONFIG.CAMERA_WIDTH, height: CONFIG.CAMERA_HEIGHT } }, '*');
    } else if (msg.type === 'info') {
      console.log('[FocusFlow Content] Proxy info:', msg.info);
    } else if (msg.type === 'error') {
      console.error('[FocusFlow Content] Proxy error:', msg.error);
    } else if (msg.type === 'worker') {
      handleWorkerMessage({ data: msg.data });
    }
  }

  async function initWorker() {
    console.log('[FocusFlow Content] initWorker called, proxyReady:', proxyReady);
    if (proxyReady) {
      console.log('[FocusFlow Content] Proxy already ready, returning');
      return;
    }
    try {
      const proxyUrl = chrome.runtime.getURL('worker-proxy.html');
      console.log('[FocusFlow Content] Creating proxy iframe:', proxyUrl);

      workerIframe = document.createElement('iframe');
      workerIframe.src = proxyUrl;
      workerIframe.style.display = 'none';
      workerIframe.setAttribute('aria-hidden', 'true');
      document.body.appendChild(workerIframe);

      window.addEventListener('message', handleProxyMessage);
      console.log('[FocusFlow Content] Proxy iframe created, waiting for ready');
    } catch (err) {
      console.error('[FocusFlow Content] Failed to create proxy:', err.name, err.message);
      workerIframe = null;
      return;
    }

    setTimeout(() => {
      if (!workerReady) {
        console.error('[FocusFlow Content] Worker failed to initialize within 15s timeout');
        cleanupProxy();
      } else {
        console.log('[FocusFlow Content] Worker ready within timeout');
      }
    }, 15000);
  }

  function cleanupProxy() {
    console.log('[FocusFlow Content] cleanupProxy called');
    window.removeEventListener('message', handleProxyMessage);
    if (workerIframe) {
      workerIframe.contentWindow?.postMessage({ type: 'terminate' }, '*');
      workerIframe.remove();
      workerIframe = null;
    }
    proxyReady = false;
    workerReady = false;
  }

  function handleWorkerMessage(e) {
    const data = e.data;
    console.log('[FocusFlow Content] Worker message received, type:', data.type, 'workerReady:', workerReady);
    if (data.type === 'ready') {
      console.log('[FocusFlow Content] Worker is ready');
      workerReady = true;
    } else if (data.type === 'landmarks') {
      pendingFrames = Math.max(0, pendingFrames - 1);
      const landmarkCount = data.landmarks ? data.landmarks.length : 0;
      console.log('[FocusFlow Content] Landmarks received, count:', landmarkCount, 'confidence:', data.confidence, 'pendingFrames:', pendingFrames);
      if (data.landmarks && data.landmarks.length > 0) {
        processAttentionSignals(data.landmarks, data.confidence);
      } else {
        console.log('[FocusFlow Content] No landmarks, calling processAttentionSignals with empty array');
        processAttentionSignals([], 0);
      }
    } else if (data.type === 'error') {
      pendingFrames = Math.max(0, pendingFrames - 1);
      console.error('[FocusFlow Content] Worker error:', data.error);
    } else {
      console.log('[FocusFlow Content] Unknown worker message type:', data.type);
    }
    if (pendingFrames <= 0) {
      console.log('[FocusFlow Content] No pending frames, scheduling next frame');
      scheduleNextFrame();
    }
  }

  async function startCamera() {
    console.log('[FocusFlow Content] startCamera called, cameraEnabled:', cameraEnabled);
    if (cameraEnabled) {
      console.log('[FocusFlow Content] Camera already enabled, skipping');
      return;
    }
    try {
      console.log('[FocusFlow Content] Requesting getUserMedia');
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: CONFIG.CAMERA_WIDTH, height: CONFIG.CAMERA_HEIGHT, facingMode: 'user' }
      });
      console.log('[FocusFlow Content] getUserMedia succeeded, stream:', !!stream, 'tracks:', stream?.getTracks().length);

      cameraVideoEl = document.createElement('video');
      cameraVideoEl.width = CONFIG.CAMERA_WIDTH;
      cameraVideoEl.height = CONFIG.CAMERA_HEIGHT;
      cameraVideoEl.autoplay = true;
      cameraVideoEl.muted = true;
      cameraVideoEl.playsInline = true;
      cameraVideoEl.srcObject = stream;
      cameraVideoEl.style.display = 'none';
      document.body.appendChild(cameraVideoEl);
      console.log('[FocusFlow Content] Camera video element created and appended');
      try { await cameraVideoEl.play(); } catch (e) { console.log('[FocusFlow Content] Camera play():', e.message); }

      cameraEnabled = true;
      console.log('[FocusFlow Content] cameraEnabled set to true');
      initFrameCapture();
      console.log('[FocusFlow Content] Frame capture initialized');
      initWorker();
      console.log('[FocusFlow Content] Worker initialization triggered');
      await loadSettings();
      console.log('[FocusFlow Content] Settings loaded');
      startFrameLoop();
      console.log('[FocusFlow Content] Frame loop started');
      notifyStateChange('FOCUSED');
      console.log('[FocusFlow Content] State notified as FOCUSED');
    } catch (err) {
      console.error('[FocusFlow Content] startCamera error:', err.name, err.message);
      notifyCameraError('denied');
    }
  }

  function stopCamera() {
    console.log('[FocusFlow Content] stopCamera called, cameraEnabled:', cameraEnabled, 'stream:', !!stream, 'proxyReady:', proxyReady);
    if (uncertainTimer) {
      console.log('[FocusFlow Content] Clearing uncertainTimer');
      clearTimeout(uncertainTimer);
      uncertainTimer = null;
    }
    cleanupProxy();
    if (cameraVideoEl) {
      console.log('[FocusFlow Content] Removing camera video element');
      cameraVideoEl.remove();
      cameraVideoEl = null;
    }
    if (stream) {
      console.log('[FocusFlow Content] Stopping stream tracks');
      stream.getTracks().forEach(t => {
        console.log('[FocusFlow Content] Stopping track:', t.kind, t.label, 'readyState:', t.readyState);
        t.stop();
        console.log('[FocusFlow Content] Track stopped, readyState:', t.readyState);
      });
      stream = null;
    }
    cameraEnabled = false;
    isProcessing = false;
    state = 'DISABLED';
    console.log('[FocusFlow Content] stopCamera complete, cameraEnabled:', cameraEnabled, 'state:', state);
    FocusFlowOverlay?.hide();
    notifyStateChange('DISABLED');
  }

  function initFrameCapture() {
    frameCanvas = document.createElement('canvas');
    frameCanvas.width = CONFIG.CAMERA_WIDTH;
    frameCanvas.height = CONFIG.CAMERA_HEIGHT;
    frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
  }

  let frameCount = 0;

  function startFrameLoop() {
    if (!cameraEnabled || !videoEl || isProcessing) return;
    captureFrame();
  }

  function captureFrame() {
    frameCount++;
    if (!cameraVideoEl || !frameCtx || cameraVideoEl.readyState < 2) {
      scheduleNextFrame();
      return;
    }

    if (frameCount % 30 === 1) {
      console.log('[FocusFlow Content] captureFrame frame:', frameCount, 'proxyReady:', proxyReady, 'workerReady:', workerReady);
    }

    frameCtx.drawImage(cameraVideoEl, 0, 0, CONFIG.CAMERA_WIDTH, CONFIG.CAMERA_HEIGHT);
    const imageData = frameCtx.getImageData(0, 0, CONFIG.CAMERA_WIDTH, CONFIG.CAMERA_HEIGHT);

    isProcessing = true;
    if (proxyReady && workerReady && workerIframe?.contentWindow) {
      pendingFrames++;
      if (frameCount % 30 === 1) console.log('[FocusFlow Content] Sending frame to proxy, pendingFrames:', pendingFrames);
      workerIframe.contentWindow.postMessage({ type: 'frame', imageData: imageData.data.buffer }, '*', [imageData.data.buffer]);
    } else {
      if (frameCount % 30 === 1) console.log('[FocusFlow Content] Worker not ready');
      scheduleNextFrame();
      isProcessing = false;
    }
  }

  function scheduleNextFrame() {
    if (!cameraEnabled) return;
    isProcessing = false;
    setTimeout(startFrameLoop, 1000 / CONFIG.FPS);
  }

  function processAttentionSignals(landmarks, confidence) {
    const confidenceThreshold = settings.faceConfidenceThreshold || 0.6;
    const landmarkCount = landmarks ? landmarks.length : 0;

    console.log('[FocusFlow Content] processAttentionSignals called, landmarks:', landmarkCount, 'confidence:', confidence, 'threshold:', confidenceThreshold);
    console.log('[FocusFlow Content] Current state:', state, 'awayStreak:', awayStreak, 'focusedStreak:', focusedStreak);

    if (isAdPlaying()) {
      console.log('[FocusFlow Content] Ad is playing, skipping attention processing');
      return;
    }

    if (confidence < confidenceThreshold) {
      console.log('[FocusFlow Content] Confidence below threshold, incrementing awayStreak');
      awayStreak++;
      focusedStreak = 0;
      console.log('[FocusFlow Content] awayStreak:', awayStreak, 'TRANSITION_FRAMES:', TRANSITION_FRAMES);
      if (awayStreak >= TRANSITION_FRAMES) {
        console.log('[FocusFlow Content] awayStreak threshold reached, calling transitionToUncertain');
        transitionToUncertain();
      }
      return;
    }

    const headPose = computeHeadPose(landmarks);
    const eyeOpenness = computeEyeOpenness(landmarks);
    console.log('[FocusFlow Content] headPose:', headPose, 'eyeOpenness:', eyeOpenness);

    const yawThreshold = settings.yawThreshold || 30;
    const pitchThreshold = settings.pitchThreshold || 25;
    const eyeThreshold = settings.eyeOpennessThreshold || 0.2;

    const yawAway = Math.abs(headPose.yaw) > yawThreshold;
    const pitchAway = Math.abs(headPose.pitch) > pitchThreshold;
    const eyesAway = eyeOpenness < eyeThreshold;
    console.log('[FocusFlow Content] Threshold checks - yawAway:', yawAway, 'pitchAway:', pitchAway, 'eyesAway:', eyesAway);

    if (yawAway || pitchAway || eyesAway) {
      console.log('[FocusFlow Content] Person is looking away, incrementing awayStreak');
      awayStreak++;
      focusedStreak = 0;
      console.log('[FocusFlow Content] awayStreak:', awayStreak, 'TRANSITION_FRAMES:', TRANSITION_FRAMES);
      if (awayStreak >= TRANSITION_FRAMES) {
        console.log('[FocusFlow Content] awayStreak threshold reached, calling transitionToUncertain');
        transitionToUncertain();
      }
    } else {
      console.log('[FocusFlow Content] Person is focused, incrementing focusedStreak');
      focusedStreak++;
      awayStreak = 0;
      console.log('[FocusFlow Content] focusedStreak:', focusedStreak, 'TRANSITION_FRAMES:', TRANSITION_FRAMES);
      if (focusedStreak >= TRANSITION_FRAMES) {
        console.log('[FocusFlow Content] focusedStreak threshold reached, calling transitionToFocused');
        transitionToFocused();
      }
    }
  }

  function computeHeadPose(landmarks) {
    const noseTip = landmarks[1];
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];

    const faceWidth = Math.abs(rightEye.x - leftEye.x);
    if (faceWidth < 0.001) return { yaw: 0, pitch: 0 };

    const eyeCenterX = (leftEye.x + rightEye.x) / 2;
    const eyeCenterY = (leftEye.y + rightEye.y) / 2;

    const noseXOffset = (noseTip.x - eyeCenterX) / (faceWidth * 0.5);
    const yaw = Math.asin(Math.max(-1, Math.min(1, noseXOffset))) * (180 / Math.PI);

    const faceHeight = Math.abs(landmarks[152].y - eyeCenterY);
    const expectedNoseY = eyeCenterY + faceHeight * 0.35;
    const noseYOffset = (noseTip.y - expectedNoseY) / (faceHeight * 0.2);
    const pitch = -Math.asin(Math.max(-1, Math.min(1, noseYOffset))) * (180 / Math.PI);

    return { yaw, pitch };
  }

  function computeEyeOpenness(landmarks) {
    const leftTop = landmarks[159];
    const leftBottom = landmarks[145];
    const leftLeft = landmarks[33];
    const leftRight = landmarks[133];

    const leftOpenness = (leftBottom.y - leftTop.y) / (leftRight.x - leftLeft.x);
    return Math.abs(leftOpenness);
  }

  function transitionToAway() {
    console.log('[FocusFlow Content] transitionToAway called, current state:', state);
    if (state === 'AWAY' || isAdPlaying()) {
      console.log('[FocusFlow Content] transitionToAway skipped - already AWAY or ad playing');
      return;
    }
    if (uncertainTimer) {
      console.log('[FocusFlow Content] Clearing uncertainTimer');
      clearTimeout(uncertainTimer);
      uncertainTimer = null;
    }
    if (videoEl && !videoEl.paused) {
      console.log('[FocusFlow Content] Pausing video, videoEl:', !!videoEl, 'paused:', videoEl.paused);
      videoEl.pause();
      focusflowPaused = true;
      state = 'AWAY';
      console.log('[FocusFlow Content] Video paused, state set to AWAY, focusflowPaused:', focusflowPaused);
      reportPause();
      notifyStateChange('AWAY');
      FocusFlowOverlay?.show();
    } else {
      console.log('[FocusFlow Content] Video already paused or no video element, state:', state, 'videoEl:', !!videoEl);
      if (videoEl) console.log('[FocusFlow Content] videoEl.paused:', videoEl.paused);
    }
  }

  function transitionToFocused() {
    console.log('[FocusFlow Content] transitionToFocused called, current state:', state);
    if (state === 'FOCUSED') {
      console.log('[FocusFlow Content] Already FOCUSED, skipping');
      return;
    }
    if (uncertainTimer) {
      console.log('[FocusFlow Content] Clearing uncertainTimer');
      clearTimeout(uncertainTimer);
      uncertainTimer = null;
    }
    state = 'FOCUSED';
    console.log('[FocusFlow Content] State set to FOCUSED, focusflowPaused:', focusflowPaused, 'videoEl:', !!videoEl);
    if (focusflowPaused && videoEl) {
      console.log('[FocusFlow Content] Resuming video playback');
      videoEl.play();
      focusflowPaused = false;
      reportResume();
      console.log('[FocusFlow Content] Video resumed');
    } else {
      console.log('[FocusFlow Content] Not resuming - focusflowPaused:', focusflowPaused, 'videoEl:', !!videoEl);
    }
    notifyStateChange('FOCUSED');
    FocusFlowOverlay?.hide();
  }

  function transitionToUncertain() {
    console.log('[FocusFlow Content] transitionToUncertain called, current state:', state);
    if (state === 'AWAY' || state === 'UNCERTAIN') {
      console.log('[FocusFlow Content] Already AWAY or UNCERTAIN, skipping');
      return;
    }
    if (uncertainTimer) {
      console.log('[FocusFlow Content] Clearing existing uncertainTimer');
      clearTimeout(uncertainTimer);
    }
    state = 'UNCERTAIN';
    const graceMs = (settings.gracePeriod || 5) * 1000;
    console.log('[FocusFlow Content] State set to UNCERTAIN, grace period:', graceMs, 'ms');
    uncertainTimer = setTimeout(() => {
      console.log('[FocusFlow Content] Grace period expired, state:', state);
      if (state === 'UNCERTAIN') {
        console.log('[FocusFlow Content] Still UNCERTAIN, calling transitionToAway');
        transitionToAway();
      } else {
        console.log('[FocusFlow Content] State changed during grace period, not transitioning');
      }
      uncertainTimer = null;
    }, graceMs);
  }

  function notifyStateChange(newState) {
    chrome.runtime.sendMessage({
      type: 'CONTENT_STATE_UPDATE',
      payload: { state: newState }
    });
  }

  function notifyCameraError(error) {
    chrome.runtime.sendMessage({ type: 'CAMERA_ERROR', payload: { error } });
  }

  let pauseStartTime = null;

  function reportPause() {
    pauseStartTime = Date.now();
    chrome.runtime.sendMessage({ type: 'REPORT_PAUSE' });
  }

  function reportResume() {
    if (pauseStartTime) {
      const pauseDuration = Date.now() - pauseStartTime;
      chrome.runtime.sendMessage({ type: 'REPORT_RESUME', payload: { pauseDuration } });
      pauseStartTime = null;
    }
  }

  async function checkVideoDisabled() {
    const videoUrl = getCurrentVideoUrl();
    if (!videoUrl) return false;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CHECK_VIDEO_DISABLED',
        payload: { url: videoUrl }
      });
      return response?.disabled || false;
    } catch (e) {
      return false;
    }
  }

  function getCurrentVideoUrl() {
    return window.location.href;
  }

  function setupServiceWorkerConnection() {
    chrome.runtime.onMessage.addListener(async (msg, sender, respond) => {
      console.log('[FocusFlow Content] Received message type:', msg.type);
      if (msg.type === 'ENABLE' || msg.type === 'START_DETECTION') {
        console.log('[FocusFlow Content] Handling START_DETECTION/ENABLE');
        const isDisabled = await checkVideoDisabled();
        console.log('[FocusFlow Content] Video disabled check:', isDisabled);
        if (isDisabled) {
          console.log('[FocusFlow Content] Video is disabled, returning');
          respond({ success: false, error: 'Video disabled', videoDisabled: true });
          return;
        }
        console.log('[FocusFlow Content] Calling startCamera()');
        startCamera();
        respond({ success: true });
      } else if (msg.type === 'DISABLE') {
        console.log('[FocusFlow Content] Handling DISABLE, calling stopCamera()');
        stopCamera();
        respond({ success: true });
        console.log('[FocusFlow Content] DISABLE handled successfully');
      } else if (msg.type === 'STOP_DETECTION') {
        console.log('[FocusFlow Content] Handling STOP_DETECTION, calling stopCamera()');
        stopCamera();
        respond({ success: true });
        console.log('[FocusFlow Content] STOP_DETECTION handled successfully');
      } else if (msg.type === 'DISABLE_CURRENT_VIDEO') {
        const url = getCurrentVideoUrl();
        chrome.runtime.sendMessage({ type: 'DISABLE_CURRENT_VIDEO', payload: { url } });
        respond({ success: true });
      } else if (msg.type === 'SETTINGS_UPDATED') {
        if (msg.payload) {
          settings = { ...settings, ...msg.payload };
        }
        respond({ success: true });
      }
      return true;
    });
  }

  function checkInitialState() {
    console.log('[FocusFlow Content] checkInitialState called');
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
      console.log('[FocusFlow Content] GET_STATE response:', response);
      if (response && response.state === 'enabled') {
        console.log('[FocusFlow Content] Tab is enabled, auto-starting camera');
        startCamera();
      } else {
        console.log('[FocusFlow Content] Tab not enabled, skipping auto-start');
      }
    });
  }

  console.log('[FocusFlow Content] Script loaded, document.readyState:', document.readyState);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  console.log('[FocusFlow Content] Scheduling checkInitialState');
  setTimeout(checkInitialState, 100);
  console.log('[FocusFlow Content] IIFE complete');
})();
