/**
 * Gets the actual bytes of an image that is displayed on the page.
 *
 * Two routes, tried in order:
 *
 *  1. Fetch from the content script. This works for same-origin ChatGPT
 *     endpoints and for `blob:` URLs the page itself created, and it avoids
 *     copying the bytes through a message channel.
 *  2. Ask the service worker. It holds the host permissions, so it can fetch
 *     cross-origin CDN URLs that step 1 cannot.
 *
 * We always fetch the address in the `src`/`srcset`, never a canvas snapshot of
 * the rendered element. A canvas readback would give us pixels only: the
 * metadata we care about would already be gone, and the result would be
 * re-encoded. Reading the file means what the user downloads is the real file.
 */

import { MESSAGE, ERROR_CODE, base64ToBytes } from '../shared/messages.js';
import { SIZE_LIMITS, FETCH_TIMEOUT_MS } from '../shared/constants.js';

/**
 * Choose the highest-resolution address available for an <img>.
 *
 * `srcset` can offer several sizes; the largest is the closest thing to the
 * original file. If we picked whatever the browser happened to render we could
 * hand the user a downscaled copy.
 */
export function bestSourceUrl(img) {
  const candidates = [];

  const srcset = img.getAttribute('srcset');
  if (srcset) {
    for (const entry of srcset.split(',')) {
      const parts = entry.trim().split(/\s+/);
      if (!parts[0]) continue;
      const descriptor = parts[1] || '';
      let weight = 1;
      if (descriptor.endsWith('w')) weight = parseFloat(descriptor) || 1;
      else if (descriptor.endsWith('x')) weight = (parseFloat(descriptor) || 1) * 1000;
      candidates.push({ url: parts[0], weight });
    }
  }

  // currentSrc is what the browser actually loaded; src is the authored value.
  if (img.currentSrc) candidates.push({ url: img.currentSrc, weight: 0 });
  if (img.src) candidates.push({ url: img.src, weight: -1 });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.weight - a.weight);

  // Resolve relative addresses against the page.
  let chosen = candidates[0].url;
  try {
    chosen = new URL(chosen, document.baseURI).href;
  } catch {
    /* keep the raw value */
  }
  return chosen;
}

/**
 * The addresses to try for this image, most preferred first.
 *
 * Several sites show a resized or re-encoded derivative of the real file. A
 * derivative does not carry the original's credentials, so inspecting one
 * would always report nothing found. An adapter can offer better addresses to
 * try; the address from the page is always kept as the final fallback, so a
 * wrong guess degrades to the old behaviour rather than breaking retrieval.
 *
 * @param {HTMLImageElement} img
 * @param {object|null} adapter
 * @returns {string[]}
 */
export function sourceUrlCandidates(img, adapter = null) {
  const pageUrl = bestSourceUrl(img);
  if (!pageUrl) return [];
  if (!adapter || typeof adapter.sourceUrlCandidates !== 'function') return [pageUrl];
  try {
    const candidates = adapter.sourceUrlCandidates(pageUrl);
    if (!Array.isArray(candidates) || candidates.length === 0) return [pageUrl];
    return candidates.includes(pageUrl) ? candidates : [...candidates, pageUrl];
  } catch {
    return [pageUrl];
  }
}

/**
 * @param {string} url
 * @returns {Promise<{ok: boolean, bytes?: Uint8Array, contentType?: string,
 *   via?: string, code?: string, error?: string}>}
 */
export async function loadImageBytes(url) {
  if (!url) return { ok: false, code: ERROR_CODE.BAD_URL, error: 'This image has no readable address.' };

  // A blob: or data: URL exists only inside the page, so only the page can
  // read it and the worker cannot help.
  const pageOnly = url.startsWith('blob:') || url.startsWith('data:');

  /*
   * Only attempt the page fetch when it can actually succeed.
   *
   * Under Manifest V3 a content-script fetch obeys the page's CORS rules. An
   * image CDN on another origin almost never sends the header that would
   * allow it, so the request is guaranteed to fail AND to print a CORS error
   * in the user's console. The service worker has the host permissions and no
   * such restriction, so for a cross-origin address we go straight there
   * rather than making a request we know will fail.
   */
  if (pageOnly || isSameOrigin(url)) {
    const direct = await fetchFromPage(url);
    if (direct.ok) return direct;
    if (pageOnly) return direct;

    const viaWorker = await fetchFromServiceWorker(url);
    if (viaWorker.ok) return viaWorker;
    return viaWorker.code === ERROR_CODE.NO_BACKGROUND ? direct : viaWorker;
  }

  const viaWorker = await fetchFromServiceWorker(url);
  if (viaWorker.ok) return viaWorker;

  // Last resort: the worker could not help, so try the page after all. It may
  // fail on CORS, but a cached or permissively served image can still work.
  const direct = await fetchFromPage(url);
  return direct.ok ? direct : viaWorker;
}

async function fetchFromPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { credentials: 'include', signal: controller.signal });
    if (!response.ok) {
      return { ok: false, code: ERROR_CODE.NETWORK, error: `The image could not be read (${response.status}).` };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sizeProblem = checkSize(bytes);
    if (sizeProblem) return sizeProblem;
    return { ok: true, bytes, contentType: response.headers.get('content-type') || '', via: 'page' };
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    return {
      ok: false,
      code: timedOut ? ERROR_CODE.TIMEOUT : ERROR_CODE.NETWORK,
      error: timedOut ? 'The image took too long to read.' : 'The image could not be read from the page.',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromServiceWorker(url) {
  try {
    const reply = await chrome.runtime.sendMessage({ type: MESSAGE.FETCH_IMAGE, url });
    if (!reply) {
      return { ok: false, code: ERROR_CODE.NO_BACKGROUND, error: 'The extension background did not respond.' };
    }
    if (!reply.ok) return { ok: false, code: reply.code || ERROR_CODE.UNKNOWN, error: reply.error };

    const bytes = base64ToBytes(reply.base64);
    const sizeProblem = checkSize(bytes);
    if (sizeProblem) return sizeProblem;
    return { ok: true, bytes, contentType: reply.contentType || '', via: 'background' };
  } catch {
    // Most commonly: the extension was reloaded or disabled mid-session, so the
    // message port is gone.
    return {
      ok: false,
      code: ERROR_CODE.NO_BACKGROUND,
      error: 'The extension was reloaded. Please refresh this page and try again.',
    };
  }
}

/** Is this address on the same origin as the page? */
function isSameOrigin(url) {
  try {
    return new URL(url, document.baseURI).origin === window.location.origin;
  } catch {
    return false;
  }
}

function checkSize(bytes) {
  if (!bytes || bytes.length === 0) {
    return { ok: false, code: ERROR_CODE.EMPTY, error: 'The image file was empty.' };
  }
  if (bytes.length > SIZE_LIMITS.MAX_BYTES) {
    return { ok: false, code: ERROR_CODE.TOO_LARGE, error: 'That image is too large to process.' };
  }
  return null;
}

/**
 * Try each candidate address in turn and return the first that yields bytes.
 *
 * @param {string[]} urls most preferred first
 * @returns {Promise<object>} the successful result, annotated with which
 *   address worked and how many were tried, or the last failure
 */
export async function loadFirstAvailable(urls) {
  if (!urls || urls.length === 0) {
    return { ok: false, code: ERROR_CODE.BAD_URL, error: 'This image has no readable address.' };
  }
  let lastFailure = null;
  for (let index = 0; index < urls.length; index += 1) {
    const result = await loadImageBytes(urls[index]);
    if (result.ok) {
      return { ...result, url: urls[index], candidateIndex: index, candidatesTried: index + 1 };
    }
    lastFailure = result;
  }
  return { ...lastFailure, candidatesTried: urls.length };
}
