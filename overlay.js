/**
 * FocusFlow On-Page Overlay
 * Appears when video is paused due to attention loss
 */

(function() {
  'use strict';

  const OVERLAY_HTML = `
    <div class="focusflow-overlay">
      <div class="focusflow-overlay-content">
        <span class="focusflow-icon">⏸</span>
        <span class="focusflow-message">Paused — look back to resume</span>
        <span class="focusflow-submessage">FocusFlow detected you looked away</span>
        <a href="#" class="focusflow-disable">Disable for this video</a>
      </div>
    </div>
  `;

  const OVERLAY_CSS = `
    .focusflow-overlay {
      position: absolute;
      bottom: 60px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.85);
      color: white;
      padding: 12px 24px;
      border-radius: 4px;
      font-family: Roboto, Arial, sans-serif;
      font-size: 14px;
      z-index: 999999;
      display: flex;
      align-items: center;
      gap: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    .focusflow-overlay-content {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .focusflow-icon {
      font-size: 18px;
    }
    .focusflow-message {
      font-weight: 500;
    }
    .focusflow-submessage {
      opacity: 0.7;
      font-size: 12px;
    }
    .focusflow-disable {
      color: #aaa;
      text-decoration: none;
      font-size: 12px;
      margin-left: 8px;
    }
    .focusflow-disable:hover {
      color: #fff;
    }
  `;

  let overlayElement = null;
  let shadowRoot = null;

  function showOverlay() {
    if (overlayElement) return;
    
    const container = document.querySelector('#movie_player');
    if (!container) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'focusflow-overlay-container';
    
    shadowRoot = wrapper.attachShadow({ mode: 'open' });
    
    const styleEl = document.createElement('style');
    styleEl.textContent = OVERLAY_CSS;
    shadowRoot.appendChild(styleEl);
    
    const template = document.createElement('template');
    template.innerHTML = OVERLAY_HTML;
    shadowRoot.appendChild(template.content.cloneNode(true));
    
    container.appendChild(wrapper);
    overlayElement = wrapper;
    
    const disableLink = shadowRoot.querySelector('.focusflow-disable');
    disableLink?.addEventListener('click', handleDisable);
  }

  function hideOverlay() {
    if (overlayElement) {
      overlayElement.remove();
      overlayElement = null;
      shadowRoot = null;
    }
  }

  function handleDisable(e) {
    e.preventDefault();
    chrome.runtime.sendMessage({ 
      type: 'DISABLE_CURRENT_VIDEO', 
      payload: { url: window.location.href }
    });
    hideOverlay();
  }

  window.FocusFlowOverlay = {
    show: showOverlay,
    hide: hideOverlay
  };
})();