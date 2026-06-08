(function() {
  'use strict';

  let worker = null;

  function handleWorkerMessage(e) {
    const data = e.data;
    window.parent.postMessage({ source: 'focusflow-proxy', type: 'worker', data: data }, '*');
  }

  function handleWorkerError(err) {
    window.parent.postMessage({ source: 'focusflow-proxy', type: 'error', error: err.message }, '*');
  }

  window.addEventListener('message', function(e) {
    if (e.source !== window.parent) return;
    const msg = e.data;
    if (!msg || msg.source === 'focusflow-proxy') return;

    if (msg.type === 'init') {
      try {
        worker = new Worker('worker/mediapipe-worker.js');
        worker.onmessage = handleWorkerMessage;
        worker.onerror = handleWorkerError;
        worker.postMessage(msg);
        window.parent.postMessage({ source: 'focusflow-proxy', type: 'info', info: 'Worker created' }, '*');
      } catch (err) {
        handleWorkerError(err);
      }
    } else if (msg.type === 'frame' && worker) {
      try {
        worker.postMessage(msg, [msg.imageData]);
      } catch (err) {
        handleWorkerError(err);
      }
    } else if (msg.type === 'terminate' && worker) {
      worker.terminate();
      worker = null;
    }
  });

  window.parent.postMessage({ source: 'focusflow-proxy', type: 'ready' }, '*');
})();
