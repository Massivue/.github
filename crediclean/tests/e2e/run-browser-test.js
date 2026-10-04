#!/usr/bin/env node
/**
 * End-to-end browser test: loads the real extension into a real Chromium and
 * drives it through the whole workflow.
 *
 * It is kept out of `npm test` because it needs a browser and a privileged
 * port. Run it with:  npm run test:e2e
 *
 * What it proves:
 *   - the extension loads with no manifest errors;
 *   - the content script injects on a chatgpt.com address;
 *   - buttons appear on generated images and NOT on avatars or icons;
 *   - images that arrive after page load also get buttons;
 *   - inspection reports credentials correctly, both present and absent;
 *   - removal produces a real download whose bytes are clean and lossless.
 *
 * What it does NOT prove: that the detector's selectors match the real
 * ChatGPT. The markup here is our reconstruction of it.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockServer } from './mock-chatgpt-server.js';
import { buildPng, buildC2paManifestStore } from '../fixtures.js';
import { inspectImage, STATUS } from '../../src/processing/metadata-inspector.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(HERE, '..', '..');

/*
 * Playwright may be installed globally rather than in this project, and ES
 * module resolution does not look in the global folder. CommonJS resolution
 * does, so borrow it.
 */
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error(
    'Playwright is not available. Install it with:  npm install --no-save playwright\n' +
      'Then run this test again. The rest of the suite (npm test) does not need it.',
  );
  process.exit(2);
}

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

async function main() {
  // A signed image big enough to pass the size filter, and a clean one.
  const signed = buildPng({
    width: 600,
    height: 400,
    c2pa: buildC2paManifestStore({
      assertions: ['c2pa.actions', 'stds.schema-org.CreativeWork'],
      claimGenerator: 'MockOpenAI/1.0',
    }),
    xmp: 'provenance',
  });
  const unsigned = buildPng({ width: 600, height: 400 });
  const avatar = buildPng({ width: 32, height: 32 });

  // Sanity-check the fixtures before relying on them in the browser.
  check('fixture: signed image really has credentials',
    inspectImage(signed).status === STATUS.CREDENTIALS_DETECTED);
  check('fixture: unsigned image really has none',
    inspectImage(unsigned).status === STATUS.NO_CREDENTIALS_DETECTED);

  const images = {
    'file-signed': { bytes: signed, contentType: 'image/png' },
    'file-unsigned': { bytes: unsigned, contentType: 'image/png' },
    'file-late': { bytes: signed, contentType: 'image/png' },
    'icon-big': { bytes: unsigned, contentType: 'image/png' },
    avatar: { bytes: avatar, contentType: 'image/png' },
  };

  const server = await startMockServer({ port: 443, images });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crediclean-e2e-'));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crediclean-dl-'));

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      // Playwright's default headless binary is a cut-down shell that cannot
      // load extensions. The full Chromium build can, including headless.
      channel: 'chromium',
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      downloadsPath: downloadDir,
      // Playwright picks up HTTPS_PROXY from the environment. This test talks
      // only to a local server, so force a direct connection and strip the
      // proxy variables from the browser's own environment too.
      proxy: { server: 'direct://', bypass: '*' },
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(https?_proxy|all_proxy|no_proxy)$/i.test(key),
        ),
      ),
      args: [
        `--disable-extensions-except=${EXTENSION}`,
        `--load-extension=${EXTENSION}`,
        // Point chatgpt.com at our mock server, so the extension runs under its
        // real https://chatgpt.com/* match patterns.
        '--host-resolver-rules=MAP chatgpt.com 127.0.0.1,MAP chat.openai.com 127.0.0.1',
        '--ignore-certificate-errors',
        // This environment sets an HTTPS proxy. Chromium would send
        // chatgpt.com through it and never reach the local mock server, so
        // this test must go direct.
        '--no-proxy-server',
        '--proxy-bypass-list=*',
        '--no-sandbox',
      ],
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });

    await page.goto('https://chatgpt.com/c/test', { waitUntil: 'load' });

    /* --- the extension injects and finds the right images ---------------- */

    // Shadow roots are open, so Playwright can see inside them.
    await page.waitForSelector('.cc-badge', { timeout: 15000 });
    check('content script injected and created at least one button', true);

    await page.waitForTimeout(800); // let the debounced scan settle

    const badgeCount = await page.locator('.cc-badge').count();
    check('exactly two buttons: one per generated image', badgeCount === 2, `found ${badgeCount}`);

    const overlayPresent = await page.locator('#crediclean-overlay-host').count();
    check('overlay host is attached to the page', overlayPresent === 1);

    // The avatar and the icon inside a button must not have been touched.
    const avatarHandled = await page.locator('#avatar[data-crediclean-handled]').count();
    const iconHandled = await page.locator('#icon-in-button[data-crediclean-handled]').count();
    check('no button on the avatar', avatarHandled === 0);
    check('no button on the large icon inside a toolbar button', iconHandled === 0);

    const signedHandled = await page.locator('#signed[data-crediclean-handled]').count();
    check('the generated image was marked as handled', signedHandled === 1);

    /* --- an image that appears later also gets a button ------------------ */

    await page.evaluate(() => window.addLateImage());
    await page.waitForFunction(
      () => document.querySelector('#crediclean-overlay-host')?.shadowRoot?.querySelectorAll('.cc-badge').length === 3,
      undefined,
      { timeout: 10000 },
    );
    check('an image added after load also gets a button', true);

    // Running the scan again must not duplicate anything.
    await page.waitForTimeout(600);
    const afterLate = await page.locator('.cc-badge').count();
    check('no duplicate buttons after rescans', afterLate === 3, `found ${afterLate}`);

    /* --- inspecting an image with credentials ---------------------------- */

    await page.locator('.cc-badge').first().click();
    await page.waitForSelector('.cc-panel', { timeout: 15000 });

    const panelText = await page.locator('.cc-panel').innerText();
    check('panel reports credentials were found', /Content Credentials found/i.test(panelText), panelText.slice(0, 120));
    check('panel shows the signer read from the file', /MockOpenAI\/1\.0/.test(panelText));
    check('panel lists an assertion from the file', /c2pa\.actions/.test(panelText));
    check('panel states the image dimensions', /600 x 400/.test(panelText));
    check('panel carries the watermark honesty note', /invisible watermark/i.test(panelText));
    check('panel does not claim the credential is valid', !/\bis valid\b/i.test(panelText));

    /* --- removing and downloading ---------------------------------------- */

    const removeButton = page.locator('.cc-panel .cc-button--primary');
    check('a remove action is offered', (await removeButton.count()) === 1);
    await removeButton.click();

    // Confirmation is on by default, so a second click is expected.
    const confirmWarning = page.locator('.cc-panel .cc-note--warn');
    await confirmWarning.waitFor({ state: 'attached', timeout: 5000 });
    check('a confirmation step is shown before anything is removed', true);

    // The confirm button must be reachable without the user hunting for it,
    // even when the report is longer than the panel. The action row is sticky,
    // so it should already be on screen.
    const confirmButton = page.locator('.cc-panel .cc-button--primary');
    check('the confirm button is visible without scrolling', await confirmButton.isVisible());
    check('the confirmation explains what will happen',
      /removes information about where the image came from/i.test(await confirmWarning.innerText()));
    check('the confirmation says the original is not changed',
      /original on ChatGPT is not changed/i.test(await confirmWarning.innerText()));

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      confirmButton.click(),
    ]);

    const suggested = download.suggestedFilename();
    check('download filename marks the file as processed', /-processed\.png$/.test(suggested), suggested);

    const savedPath = await download.path();
    const savedBytes = new Uint8Array(fs.readFileSync(savedPath));
    const savedReport = inspectImage(savedBytes);

    check('downloaded file is a valid PNG', savedReport.format === 'png');
    check('downloaded file has no credentials left',
      savedReport.status === STATUS.NO_CREDENTIALS_DETECTED, savedReport.status);
    check('downloaded file keeps its dimensions',
      savedReport.dimensions?.width === 600 && savedReport.dimensions?.height === 400,
      JSON.stringify(savedReport.dimensions));
    check('downloaded file is smaller than the original', savedBytes.length < signed.length);
    check('no caBX chunk survives in the downloaded file',
      !Buffer.from(savedBytes).toString('latin1').includes('caBX'));

    const successText = await page.locator('.cc-panel').innerText();
    check('success is only reported after the file exists', /removed and file saved/i.test(successText));
    check('success panel lists the verification checks', /Checks run on the saved file/i.test(successText));
    check('success panel says the original is unchanged', /original.*unchanged/i.test(successText));

    /* --- the image with no credentials ----------------------------------- */

    await page.keyboard.press('Escape');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(400);

    // Badges for images that are off screen are hidden on purpose, so scroll to
    // the second image first, the way a user would. That it becomes visible
    // again on scroll is itself worth checking.
    await page.locator('#unsigned').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    check('a badge reappears when its image is scrolled back into view',
      await page.locator('.cc-badge').nth(1).isVisible());

    await page.locator('.cc-badge').nth(1).click();
    await page.waitForSelector('.cc-panel', { timeout: 15000 });
    const cleanText = await page.locator('.cc-panel').innerText();

    check('an image with no credentials says so plainly',
      /No supported credentials found/i.test(cleanText), cleanText.slice(0, 120));
    check('and does not claim that proves anything',
      /not proof/i.test(cleanText), cleanText.slice(0, 200));
    check('no remove action is offered when there is nothing to remove',
      (await page.locator('.cc-panel .cc-button--primary').count()) === 0);

    /* --- the popup page loads -------------------------------------------- */

    const extensionId = context
      .serviceWorkers()
      .map((worker) => new URL(worker.url()).host)
      .find(Boolean);
    if (extensionId) {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await popup.waitForSelector('#status-text');
      const statusText = await popup.locator('#status-text').innerText();
      check('popup opens and shows a status', statusText.length > 0 && statusText !== 'Checking…', statusText);
      check('popup shows the privacy statement',
        /does not upload your images/i.test(await popup.locator('body').innerText()));
      await popup.close();
    } else {
      check('popup could be opened', false, 'could not determine the extension id');
    }

    /* --- nothing broke the page ------------------------------------------ */

    // Only certificate noise from the self-signed test cert is tolerated.
    const realErrors = pageErrors.filter((text) => !/ERR_CERT/i.test(text));
    check('no page errors were raised', realErrors.length === 0, realErrors.join(' | '));

    /* --- a look at the result, for the record ----------------------------- */

    if (process.env.CREDICLEAN_SCREENSHOT) {
      await page.locator('#signed').scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.locator('.cc-badge').first().click();
      await page.waitForSelector('.cc-panel');
      await page.screenshot({ path: process.env.CREDICLEAN_SCREENSHOT, fullPage: false });
      console.log(`  info screenshot written to ${process.env.CREDICLEAN_SCREENSHOT}`);
    }
  } finally {
    if (context) await context.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nThe browser test could not run:', error);
  process.exit(2);
});
