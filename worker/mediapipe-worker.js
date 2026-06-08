let isReady = false;
let faceLandmarker = null;
let canvasWidth = 192;
let canvasHeight = 192;

self.onmessage = async function(e) {
  const data = e.data;
  console.log('[FocusFlow Worker] Message received, type:', data.type);
  if (data.type === 'init') {
    console.log('[FocusFlow Worker] Init received, config:', data.config);
    if (data.config) {
      canvasWidth = data.config.width || 192;
      canvasHeight = data.config.height || 192;
    }
    await initializeLandmarker();
  } else if (data.type === 'frame') {
    console.log('[FocusFlow Worker] Frame received, imageData length:', data.imageData ? data.imageData.byteLength : 0);
    await processFrame(data.imageData);
  }
};

async function initializeLandmarker() {
  try {
    const baseDir = typeof EXTENSION_BASE_URL !== 'undefined'
      ? EXTENSION_BASE_URL.replace(/\/$/, '')
      : (() => { const u = self.location.href; return u.substring(0, u.lastIndexOf('/')); })();
    const wasmBase = baseDir + '/wasm/';
    console.log('[FocusFlow Worker] Initializing, baseDir:', baseDir, 'wasmBase:', wasmBase);

    self.exports = {};
    console.log('[FocusFlow Worker] Loading vision_bundle.js from:', baseDir + '/vision_bundle.js');
    importScripts(baseDir + '/vision_bundle.js');
    console.log('[FocusFlow Worker] vision_bundle.js loaded, exports keys:', Object.keys(self.exports));
    const vision = self.exports;
    console.log('[FocusFlow Worker] Creating FilesetResolver from:', wasmBase);
    const resolver = await vision.FilesetResolver.forVisionTasks(wasmBase);
    console.log('[FocusFlow Worker] FilesetResolver created');

    console.log('[FocusFlow Worker] Creating FaceLandmarker');
    faceLandmarker = await vision.FaceLandmarker.createFromOptions(resolver, {
      baseOptions: {
        modelAssetPath: wasmBase + 'face_landmarker.task',
        delegate: 'GPU'
      },
      runningMode: 'IMAGE',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false
    });
    console.log('[FocusFlow Worker] FaceLandmarker created successfully');

    isReady = true;
    console.log('[FocusFlow Worker] Worker ready, posting ready message');
    self.postMessage({ type: 'ready', ready: true });
  } catch (err) {
    console.error('[FocusFlow Worker] Init error:', err.message, err.stack);
    self.postMessage({ type: 'error', error: err.message });
  }
}

async function processFrame(imageDataBuffer) {
  console.log('[FocusFlow Worker] processFrame called, isReady:', isReady, 'faceLandmarker:', !!faceLandmarker);
  if (!isReady || !faceLandmarker) {
    console.log('[FocusFlow Worker] Not ready, returning empty landmarks');
    self.postMessage({ type: 'landmarks', landmarks: [], confidence: 0 });
    return;
  }

  try {
    if (typeof imageDataBuffer === 'object' && imageDataBuffer instanceof ArrayBuffer) {
      const clamped = new Uint8ClampedArray(new Uint8Array(imageDataBuffer));
      const imageData = new ImageData(
        new Uint8ClampedArray(clamped),
        canvasWidth,
        canvasHeight
      );
      console.log('[FocusFlow Worker] ImageData created, size:', imageData.width, 'x', imageData.height);

      const detections = await faceLandmarker.detect(imageData);
      const hasLandmarks = detections.faceLandmarks && detections.faceLandmarks.length > 0;
      const landmarkCount = hasLandmarks ? detections.faceLandmarks[0].length : 0;
      const hasBlendshapes = detections.faceBlendshapes && detections.faceBlendshapes.length > 0;
      console.log('[FocusFlow Worker] Detection complete, hasLandmarks:', hasLandmarks, 'landmarkCount:', landmarkCount, 'hasBlendshapes:', hasBlendshapes);

      const landmarks = hasLandmarks
        ? detections.faceLandmarks[0].map(lm => ({ x: lm.x, y: lm.y, z: lm.z }))
        : [];
      const confidence = hasLandmarks
        ? (hasBlendshapes ? detections.faceBlendshapes[0].score : 0.95)
        : 0;
      console.log('[FocusFlow Worker] Posting landmarks back, count:', landmarks.length, 'confidence:', confidence);

      self.postMessage({
        type: 'landmarks',
        landmarks,
        confidence,
        inferenceTime: Date.now()
      }, undefined);
    } else {
      console.log('[FocusFlow Worker] Invalid imageData, not an ArrayBuffer');
      self.postMessage({ type: 'landmarks', landmarks: [], confidence: 0 });
    }
  } catch (err) {
    console.error('[FocusFlow Worker] processFrame error:', err.message, err.stack);
    self.postMessage({ type: 'error', error: err.message });
  }
}

self.postMessage({ type: 'worker_loaded' });
