/**
 * Google Gemini.
 *
 * STATUS: implemented from research, NOT verified against the live site.
 *
 * What is documented by Google: images generated in the Gemini app carry C2PA
 * Content Credentials, and Google also applies SynthID, an invisible watermark
 * carried in the pixels.
 *
 * CrediClean removes the C2PA manifest. It does NOT touch SynthID and cannot.
 * A Gemini image processed here will still carry its SynthID watermark, and
 * that is expected behaviour, not a failure of the removal.
 *
 * What is NOT confirmed: the exact CDN host for generated images. No Google
 * documentation states it. The hosts below are the Google user-content domains
 * generated images are most likely to come from, and detection therefore leans
 * on page structure and image size rather than on the address.
 */

import { defineAdapter, SUPPORT } from './base.js';

export const geminiAdapter = defineAdapter({
  id: 'gemini',
  name: 'Gemini',

  hosts: ['gemini.google.com'],

  // NOT CONFIRMED. Generated images are expected on Google's user-content
  // domains. This one cannot be narrowed further with confidence: Google
  // spreads user content across lh3, lh4, lh5 and similar subdomains, so a
  // single subdomain would miss images. If retrieval fails, the console logs
  // the real host so this list can be corrected.
  imageHosts: ['gemini.google.com', 'googleusercontent.com', 'usercontent.google.com'],

  conversationSelectors: [
    'model-response',
    'message-content',
    '[data-test-id="model-response"]',
    '[role="log"]',
    'main',
  ],

  // Left deliberately narrow: the generated-image host is unconfirmed, so an
  // address allowlist would be a guess. Structure and size carry the decision.
  contentUrlFragments: [],

  // Google account profile pictures live under googleusercontent.com/a/, which
  // the shared exclusions already cover. These are Gemini's own interface assets.
  extraExcludedFragments: ['gstatic.com', 'www.google.com/images'],

  /**
   * Ask Google's image CDN for the ORIGINAL file rather than the derivative
   * shown on the page.
   *
   * THIS IS THE LIKELIEST REASON A GEMINI IMAGE REPORTS NO CREDENTIALS.
   *
   * Google serves images from googleusercontent.com through a resizing CDN.
   * The address in the page ends with an options string after an `=`, such as
   * `=w526-h296-rw`, which asks for a particular width, height and format.
   * What comes back is a **derivative**: the CDN re-encodes it on the fly, and
   * a re-encoded copy does not carry the original's C2PA manifest. Inspecting
   * it will always report no credentials, no matter how correct the engine is.
   *
   * Replacing the options with `=s0` asks for the original, at original
   * resolution and in its original format.
   *
   * INFERENCE, not vendor-documented: the `=s0` convention is well established
   * and widely corroborated, but Google does not publish it as an API. So this
   * returns candidates rather than a single address: if the rewritten one
   * fails, the loader falls back to the address from the page, and the user
   * still gets the behaviour they had before.
   *
   * @param {string} url
   * @returns {string[]} addresses to try, most preferred first
   */
  sourceUrlCandidates(url) {
    const candidates = [];
    try {
      const parsed = new URL(url);
      const isGoogleCdn =
        parsed.hostname.endsWith('googleusercontent.com') ||
        parsed.hostname.endsWith('usercontent.google.com');

      if (isGoogleCdn) {
        // The options string sits at the end of the PATH, after the last '='.
        const path = parsed.pathname;
        const marker = path.lastIndexOf('=');
        const options = marker === -1 ? null : path.slice(marker + 1);
        const looksLikeOptions = options !== null && /^[a-z0-9]+(-[a-z0-9]+)*$/i.test(options);

        const original = new URL(parsed.href);
        original.pathname = looksLikeOptions ? `${path.slice(0, marker)}=s0` : `${path}=s0`;
        candidates.push(original.href);
      }
    } catch {
      /* fall through to the page's own address */
    }

    // Always keep the address from the page as the last resort.
    if (!candidates.includes(url)) candidates.push(url);
    return candidates;
  },

  support: {
    imageDetection: SUPPORT.UNVERIFIED,
    // Documented by Google, but we have not inspected a real Gemini file.
    c2paDetection: SUPPORT.UNVERIFIED,
    processing: SUPPORT.UNVERIFIED,
  },

  /**
   * Shown nowhere in the UI. Recorded so the project never loses track of the
   * fact that removing C2PA here leaves a watermark behind.
   */
  knownUnremovableProvenance: ['SynthID (invisible pixel watermark)'],
});
