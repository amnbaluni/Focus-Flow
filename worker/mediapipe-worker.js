let isReady = false;
let faceLandmarker = null;
let canvasWidth = 192;
let canvasHeight = 192;

self.onmessage = async function(e) {
  const data = e.data;
  if (data.type === 'init') {
    if (data.config) {
      canvasWidth = data.config.width || 192;
      canvasHeight = data.config.height || 192;
    }
    await initializeLandmarker();
  } else if (data.type === 'frame') {
    await processFrame(data.imageData);
  }
};

async function initializeLandmarker() {
  try {
    const baseDir = typeof EXTENSION_BASE_URL !== 'undefined'
      ? EXTENSION_BASE_URL.replace(/\/$/, '')
      : (() => { const u = self.location.href; return u.substring(0, u.lastIndexOf('/')); })();
    const wasmBase = baseDir + '/wasm/';
    
    self.exports = {};
    importScripts(baseDir + '/vision_bundle.js');
    const vision = self.exports;
    const resolver = await vision.FilesetResolver.forVisionTasks(wasmBase);
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
    
    isReady = true;
    self.postMessage({ type: 'ready', ready: true });
  } catch (err) {
    console.error('[FocusFlow Worker] Init error:', err.message, err.stack);
    self.postMessage({ type: 'error', error: err.message });
  }
}

async function processFrame(imageDataBuffer) {
  if (!isReady || !faceLandmarker) {
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
      
      const detections = await faceLandmarker.detect(imageData);
      const hasLandmarks = detections.faceLandmarks && detections.faceLandmarks.length > 0;
      const landmarkCount = hasLandmarks ? detections.faceLandmarks[0].length : 0;
      const hasBlendshapes = detections.faceBlendshapes && detections.faceBlendshapes.length > 0;
      
      const landmarks = hasLandmarks
        ? detections.faceLandmarks[0].map(lm => ({ x: lm.x, y: lm.y, z: lm.z }))
        : [];
      const confidence = hasLandmarks
        ? (hasBlendshapes ? detections.faceBlendshapes[0].score : 0.95)
        : 0;
      
      self.postMessage({
        type: 'landmarks',
        landmarks,
        confidence,
        inferenceTime: Date.now()
      }, undefined);
    } else {
      self.postMessage({ type: 'landmarks', landmarks: [], confidence: 0 });
    }
  } catch (err) {
    console.error('[FocusFlow Worker] processFrame error:', err.message, err.stack);
    self.postMessage({ type: 'error', error: err.message });
  }
}

self.postMessage({ type: 'worker_loaded' });
