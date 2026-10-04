/**
 * Image detection on ChatGPT.
 *
 * These exercise the decision logic with plain stand-in objects rather than a
 * real browser. That covers the rules, but it CANNOT prove the selectors match
 * the real ChatGPT page, which only a manual browser test can confirm. See
 * docs/TESTING.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyImageUrl,
  evaluateImage,
  isImageLoaded,
  CLASSIFICATION,
  MIN_CONTENT_EDGE_PX,
} from '../src/content/image-detector.js';

/** A stand-in for an <img>, exposing only the properties the detector reads. */
function fakeImage({
  src = 'https://files.oaiusercontent.com/file-abc123',
  naturalWidth = 1024,
  naturalHeight = 1024,
  complete = true,
  ancestors = [],
  alt = '',
} = {}) {
  return {
    src,
    currentSrc: src,
    naturalWidth,
    naturalHeight,
    clientWidth: naturalWidth,
    clientHeight: naturalHeight,
    complete,
    getAttribute: (name) => (name === 'src' ? src : name === 'alt' ? alt : null),
    closest: (selector) => (ancestors.includes(selector) ? { tagName: 'DIV' } : null),
  };
}

test('OpenAI content hosts are treated as content', () => {
  assert.equal(classifyImageUrl('https://files.oaiusercontent.com/file-abc'), CLASSIFICATION.CONTENT);
  assert.equal(classifyImageUrl('https://sdmntprwestus.oaiusercontent.com/files/x.png'), CLASSIFICATION.CONTENT);
  assert.equal(classifyImageUrl('https://chatgpt.com/backend-api/estuary/content?id=file-1'), CLASSIFICATION.CONTENT);
  assert.equal(classifyImageUrl('blob:https://chatgpt.com/8a7f-21'), CLASSIFICATION.CONTENT);
});

test('interface assets are excluded', () => {
  assert.equal(classifyImageUrl('https://cdn.oaistatic.com/assets/logo.svg'), CLASSIFICATION.INTERFACE);
  assert.equal(classifyImageUrl('https://lh3.googleusercontent.com/a/profile-pic'), CLASSIFICATION.INTERFACE);
  assert.equal(classifyImageUrl('https://example.com/avatar/user.png'), CLASSIFICATION.INTERFACE);
  assert.equal(classifyImageUrl('https://example.com/favicon.ico'), CLASSIFICATION.INTERFACE);
  assert.equal(classifyImageUrl('data:image/svg+xml;base64,AAAA'), CLASSIFICATION.INTERFACE);
  assert.equal(classifyImageUrl(''), CLASSIFICATION.INTERFACE);
  assert.equal(classifyImageUrl(null), CLASSIFICATION.INTERFACE);
});

test('an unfamiliar host is neither accepted nor rejected on the address alone', () => {
  assert.equal(classifyImageUrl('https://example.com/some-picture.png'), CLASSIFICATION.UNKNOWN);
});

test('a large generated image is eligible', () => {
  const verdict = evaluateImage(fakeImage());
  assert.equal(verdict.eligible, true);
  assert.equal(verdict.url, 'https://files.oaiusercontent.com/file-abc123');
});

test('small images are rejected, which is what keeps avatars and icons clean', () => {
  const small = fakeImage({ naturalWidth: MIN_CONTENT_EDGE_PX - 1, naturalHeight: 512 });
  assert.equal(evaluateImage(small).eligible, false);
  assert.equal(evaluateImage(small).reason, 'too-small');
});

test('an image inside a button is rejected even if it is large', () => {
  const inButton = fakeImage({ ancestors: ['button'] });
  const verdict = evaluateImage(inButton);
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, 'inside-interface');
});

test('an image inside navigation or a header is rejected', () => {
  assert.equal(evaluateImage(fakeImage({ ancestors: ['nav'] })).reason, 'inside-interface');
  assert.equal(evaluateImage(fakeImage({ ancestors: ['header'] })).reason, 'inside-interface');
  assert.equal(evaluateImage(fakeImage({ ancestors: ['[role="button"]'] })).reason, 'inside-interface');
});

test('an image that has not loaded yet is deferred, not rejected outright', () => {
  const loading = fakeImage({ complete: false, naturalWidth: 0, naturalHeight: 0 });
  const verdict = evaluateImage(loading);
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, 'not-loaded', 'the watcher relies on this exact reason to retry later');
});

test('an image that failed to load is not eligible', () => {
  const broken = fakeImage({ complete: true, naturalWidth: 0, naturalHeight: 0 });
  assert.equal(isImageLoaded(broken), false);
  assert.equal(evaluateImage(broken).eligible, false);
});

test('an unfamiliar host is accepted only inside a message element', () => {
  const outside = fakeImage({ src: 'https://example.com/picture.png' });
  assert.equal(evaluateImage(outside).eligible, false);
  assert.equal(evaluateImage(outside).reason, 'unknown-host-outside-message');

  const inside = fakeImage({
    src: 'https://example.com/picture.png',
    ancestors: ['[data-message-author-role]'],
  });
  assert.equal(evaluateImage(inside).eligible, true);
});

test('missing or malformed elements are handled without throwing', () => {
  assert.equal(evaluateImage(null).eligible, false);
  assert.equal(evaluateImage({}).eligible, false);
  assert.equal(evaluateImage({ src: '' }).eligible, false);
});
