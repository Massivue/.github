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
