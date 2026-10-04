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
  try {
    return new URL(candidates[0].url, document.baseURI).href;
  } catch {
    return candidates[0].url;
  }
}

/**
 * @param {string} url
 * @returns {Promise<{ok: boolean, bytes?: Uint8Array, contentType?: string,
 *   via?: string, code?: string, error?: string}>}
 */
export async function loadImageBytes(url) {
  if (!url) return { ok: false, code: ERROR_CODE.BAD_URL, error: 'This image has no readable address.' };

  const direct = await fetchFromPage(url);
  if (direct.ok) return direct;

  // A blob: or data: URL only exists in the page, so the worker cannot help.
  if (url.startsWith('blob:') || url.startsWith('data:')) return direct;

  const viaWorker = await fetchFromServiceWorker(url);
  if (viaWorker.ok) return viaWorker;

  // Report whichever failure is more informative.
  return viaWorker.code === ERROR_CODE.NO_BACKGROUND ? direct : viaWorker;
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

function checkSize(bytes) {
  if (!bytes || bytes.length === 0) {
    return { ok: false, code: ERROR_CODE.EMPTY, error: 'The image file was empty.' };
  }
  if (bytes.length > SIZE_LIMITS.MAX_BYTES) {
    return { ok: false, code: ERROR_CODE.TOO_LARGE, error: 'That image is too large to process.' };
  }
  return null;
}
