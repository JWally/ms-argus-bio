/**
 * Argus Bio — Embeddable CAPTCHA widget
 * Usage:
 *   <script src="https://bio.argus.pw/argus-bio.js"></script>
 *   <script>
 *     ArgusBio.open({
 *       sessionId: "...",          // from POST /v1/session
 *       onVerified: (token) => {}, // called on success
 *       onError: (msg) => {},      // called on server error
 *       onClose: () => {},         // called if user dismisses
 *     });
 *   </script>
 */
(function () {
  'use strict';

  var ORIGIN = (function () {
    var s = document.currentScript;
    if (s && s.src) {
      var u = new URL(s.src);
      return u.origin;
    }
    return 'https://bio.argus.pw';
  })();

  var overlay = null;
  var iframe = null;
  var currentOpts = null;
  var savedOverflow = '';
  var inertedEls = [];

  function muteHostPage() {
    // Lock scroll
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Mark all siblings inert so browser skips layout/events/a11y for them
    var children = document.body.children;
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      if (el === overlay || el.id === 'argus-bio-overlay') continue;
      if (!el.inert) {
        el.inert = true;
        inertedEls.push(el);
      }
    }
  }

  function unmuteHostPage() {
    document.body.style.overflow = savedOverflow;
    for (var i = 0; i < inertedEls.length; i++) {
      inertedEls[i].inert = false;
    }
    inertedEls = [];
  }

  function open(opts) {
    if (!opts || !opts.sessionId) {
      throw new Error('ArgusBio.open: sessionId is required');
    }
    if (overlay) close();
    currentOpts = opts;

    // Overlay
    overlay = document.createElement('div');
    overlay.id = 'argus-bio-overlay';
    var os = overlay.style;
    os.position = 'fixed';
    os.top = '0';
    os.left = '0';
    os.width = '100%';
    os.height = '100%';
    os.zIndex = '2147483647';
    os.background = 'rgba(0,0,0,0.6)';
    os.display = 'flex';
    os.alignItems = 'center';
    os.justifyContent = 'center';
    os.backdropFilter = 'blur(4px)';
    os.touchAction = 'none';
    os.overscrollBehavior = 'none';

    // Prevent touch-scroll bounce on the overlay
    overlay.addEventListener(
      'touchmove',
      function (e) {
        e.preventDefault();
      },
      { passive: false }
    );

    // Container (responsive sizing)
    var container = document.createElement('div');
    var cs = container.style;
    cs.position = 'relative';
    cs.overflow = 'hidden';
    var mobile = window.matchMedia('(max-width: 640px)').matches;
    if (mobile) {
      cs.width = '100%';
      cs.height = '100%';
    } else {
      cs.width = '100%';
      cs.maxWidth = '480px';
      cs.margin = '0 8px';
      cs.height = '90dvh';
      cs.maxHeight = '900px';
      cs.borderRadius = '16px';
      cs.boxShadow = '0 25px 50px rgba(0,0,0,0.3)';
    }

    // Close button
    var closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute('aria-label', 'Close');
    var bs = closeBtn.style;
    bs.position = 'absolute';
    bs.top = '8px';
    bs.right = '8px';
    bs.zIndex = '1';
    bs.width = '32px';
    bs.height = '32px';
    bs.border = 'none';
    bs.borderRadius = '50%';
    bs.background = 'rgba(0,0,0,0.5)';
    bs.color = '#fff';
    bs.fontSize = '20px';
    bs.lineHeight = '1';
    bs.cursor = 'pointer';
    bs.display = 'flex';
    bs.alignItems = 'center';
    bs.justifyContent = 'center';
    closeBtn.onclick = function () {
      close();
      if (currentOpts && currentOpts.onClose) currentOpts.onClose();
    };

    // Iframe
    iframe = document.createElement('iframe');
    iframe.src = ORIGIN + '/?sid=' + encodeURIComponent(opts.sessionId) + '&embed=1';
    iframe.allow = 'clipboard-write';
    var is = iframe.style;
    is.width = '100%';
    is.height = '100%';
    is.border = 'none';

    container.appendChild(iframe);
    container.appendChild(closeBtn);
    overlay.appendChild(container);
    document.body.appendChild(overlay);
    muteHostPage();

    // Click outside to close
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        close();
        if (currentOpts && currentOpts.onClose) currentOpts.onClose();
      }
    });

    // Escape to close
    document.addEventListener('keydown', onEscape);
  }

  function close() {
    document.removeEventListener('keydown', onEscape);
    unmuteHostPage();
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    overlay = null;
    iframe = null;
  }

  function onEscape(e) {
    if (e.key === 'Escape') {
      close();
      if (currentOpts && currentOpts.onClose) currentOpts.onClose();
    }
  }

  // Listen for postMessage from the CAPTCHA iframe
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN) return;
    var data = e.data;
    if (!data) return;

    if (data.type === 'argus-bio-verified') {
      close();
      if (currentOpts && currentOpts.onVerified) {
        currentOpts.onVerified(data.token);
      }
    } else if (data.type === 'argus-bio-error') {
      close();
      if (currentOpts && currentOpts.onError) {
        currentOpts.onError(data.error);
      }
    }
  });

  window.ArgusBio = {
    open: open,
    close: close,
  };
})();
