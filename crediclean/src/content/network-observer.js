/**
 * Records the image addresses a page fetches, so a blob-backed <img> can be
 * traced back to the file it came from.
 *
 * WHY THIS EXISTS
 *
 * Gemini shows generated images from `blob:` addresses. A blob is bytes the
 * page built in memory. Diagnosing a real one showed a JPEG with no EXIF, no
 * XMP and no APP11 segment: the page had re-encoded the picture, destroying
 * its Content Credentials before the extension could see anything.
 *
 * Searching the markup for the original turned up nothing. The page keeps no
 * address for it anywhere in the DOM.
 *
 * But the page must have downloaded the picture from somewhere. This records
 * those downloads as they happen, so when the user asks about a blob-backed
 * image we have a list of real addresses to try instead.
 *
 * ============================= IMPORTANT ==============================
 * This runs in the PAGE'S OWN JavaScript world, not the extension's, which
 * is the only way to see the page's network calls. That makes it the most
 * intrusive code in this extension, so it is written to be impossible to
 * break the host page with:
 *
 *   - every wrapper calls through to the original, always;
 *   - every wrapper is wrapped in try/catch, and a failure falls straight
 *     through to the original behaviour;
 *   - nothing is ever blocked, delayed, rewritten or retried;
 *   - no response body is ever read, so no stream is consumed;
 *   - only addresses and content types are recorded, never image data.
 *
 * It is injected ONLY on platforms whose adapter asks for it. ChatGPT does
 * not, deliberately: it already works, and nothing here should put that at
 * risk.
 * ======================================================================
 */

(function installNetworkObserver() {
  const FLAG = '__crediCleanNetworkObserver';
  if (window[FLAG]) return;
  window[FLAG] = true;

  /** The most recent image responses, newest last. Addresses only. */
  const seen = [];
  const MAX_RECORDED = 40;

  function record(url, contentType, contentLength) {
    try {
      if (typeof url !== 'string' || !/^https?:/i.test(url)) return;
      // Only images, and only ones big enough to be real content.
      if (contentType && !/^image\//i.test(contentType)) return;
      if (contentLength && Number(contentLength) < 8192) return;

      const existing = seen.findIndex((entry) => entry.url === url);
      if (existing !== -1) seen.splice(existing, 1);

      seen.push({ url, contentType: contentType || '', bytes: Number(contentLength) || 0, at: Date.now() });
      while (seen.length > MAX_RECORDED) seen.shift();
    } catch {
      /* recording must never affect the page */
    }
  }

  /* --- fetch ---------------------------------------------------------- */

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function crediCleanFetch(...args) {
      const result = originalFetch.apply(this, args);
      try {
        if (result && typeof result.then === 'function') {
          result.then(
            (response) => {
              try {
                // Headers only. The body is never touched, so the page's own
                // read of it is completely unaffected.
                record(
                  response.url,
                  response.headers && response.headers.get('content-type'),
                  response.headers && response.headers.get('content-length'),
                );
              } catch {
                /* ignore */
              }
              return response;
            },
            (error) => error,
          );
        }
      } catch {
        /* ignore */
      }
      return result;
    };
  }

  /* --- XMLHttpRequest ------------------------------------------------- */

  const OriginalXhr = window.XMLHttpRequest;
  if (OriginalXhr && OriginalXhr.prototype) {
    const originalOpen = OriginalXhr.prototype.open;
    const originalSend = OriginalXhr.prototype.send;

    OriginalXhr.prototype.open = function crediCleanOpen(method, url, ...rest) {
      try {
        this[FLAG] = url;
      } catch {
        /* ignore */
      }
      return originalOpen.call(this, method, url, ...rest);
    };

    OriginalXhr.prototype.send = function crediCleanSend(...args) {
      try {
        this.addEventListener('load', () => {
          try {
            record(
              this.responseURL || this[FLAG],
              this.getResponseHeader && this.getResponseHeader('content-type'),
              this.getResponseHeader && this.getResponseHeader('content-length'),
            );
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }
      return originalSend.apply(this, args);
    };
  }

  /* --- answering the extension ---------------------------------------- */

  /*
   * The extension's own code runs in a separate world and cannot read these
   * variables directly, so it asks by dispatching an event and we answer with
   * one. Only addresses cross the boundary.
   */
  document.addEventListener('crediclean:ask-for-sources', () => {
    try {
      document.dispatchEvent(
        new CustomEvent('crediclean:sources', {
          detail: { urls: seen.map((entry) => entry.url) },
        }),
      );
    } catch {
      /* ignore */
    }
  });
})();
