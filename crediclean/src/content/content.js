/**
 * CrediClean content script: the entry point that runs on ChatGPT.
 *
 * A Manifest V3 content script cannot use `import` statements directly, so this
 * file is a small classic script that dynamically imports the real modules from
 * the extension package. Those modules are listed in `web_accessible_resources`
 * in the manifest, which is what makes the dynamic import possible.
 *
 * Keeping the logic in modules means the exact same code that runs in the
 * browser is also what the test suite runs under Node, with no build step and
 * no second copy to keep in sync.
 */

(async function bootstrap() {
  // Guard against being injected twice (for example after an extension reload).
  if (window.__crediCleanLoaded) return;
  window.__crediCleanLoaded = true;

  const moduleUrl = (path) => chrome.runtime.getURL(`src/${path}`);

  let modules;
  try {
    modules = await Promise.all([
      import(moduleUrl('content/image-detector.js')),
      import(moduleUrl('content/overlay.js')),
      import(moduleUrl('content/button-manager.js')),
      import(moduleUrl('processing/image-loader.js')),
      import(moduleUrl('processing/metadata-inspector.js')),
      import(moduleUrl('processing/credential-processor.js')),
      import(moduleUrl('processing/download-manager.js')),
      import(moduleUrl('shared/settings.js')),
      import(moduleUrl('platforms/index.js')),
    ]);
  } catch (error) {
    // Without the modules there is nothing we can do, but we must not break the
    // page. Log for local debugging and stop.
    console.warn('[CrediClean] Could not load its own modules; the extension is inactive.', error);
    return;
  }

  const [
    detector,
    overlayModule,
    ui,
    imageLoader,
    inspectorModule,
    processorModule,
    downloadManager,
    settingsModule,
    platforms,
  ] = modules;

  /*
   * Which site are we on? Everything site-specific lives in that platform's
   * adapter; the rest of the extension is shared. If no adapter claims this
   * host we do nothing at all rather than guess at the page structure.
   */
  const adapter = platforms.currentAdapter();
  if (!adapter) {
    console.warn('[CrediClean] No platform adapter for this site; staying inactive.');
    return;
  }
  detector.setAdapter(adapter);

  const { OUTCOME } = processorModule;

  let settings = await settingsModule.loadSettings();
  const overlay = new overlayModule.Overlay();
  let watcher = null;
  let buttons = null;

  /* --------------------------------------------------------------------- */
  /* The main action: read the image, inspect it, offer what we can do      */
  /* --------------------------------------------------------------------- */

  async function handleInspect(entry, badgeUi) {
    badgeUi.setBusy(true, 'Reading\u2026');

    const url = imageLoader.bestSourceUrl(entry.img, adapter);
    const loaded = await imageLoader.loadImageBytes(url);

    // The user may have scrolled the image away or switched conversation while
    // we were fetching. Do not draw a panel onto an image that has gone.
    if (!entry.img.isConnected) {
      badgeUi.setBusy(false);
      return;
    }

    if (!loaded.ok) {
      badgeUi.setBusy(false);
      badgeUi.showPanel((body) => ui.renderError(body, loaded.error || 'Please try again.'));
      return;
    }

    let report;
    try {
      report = inspectorModule.inspectImage(loaded.bytes);
    } catch (error) {
      console.warn('[CrediClean] Inspection failed.', error);
      badgeUi.setBusy(false);
      badgeUi.showPanel((body) => ui.renderError(body, 'Please try again.'));
      return;
    }

    badgeUi.setBusy(false);

    const altText = entry.img.getAttribute('alt') || '';
    const filename = downloadManager.sourceFilename({ url, format: report.format, altText });

    badgeUi.showPanel((body, controls) => {
      // One state object drives every phase, so the panel keeps the same shape
      // from first open through to the saved confirmation.
      const state = {
        report,
        filename,
        phase: 'ready',
        onClose: controls.close,
        onRemove: () => runRemoval({ body, state, report, bytes: loaded.bytes, url, altText }),
      };
      ui.renderPanel(body, state);
    });
  }

  /**
   * Process and save, straight from the one button press.
   *
   * There is deliberately no second confirmation. Pressing a button labelled
   * "Remove credentials & save" is the confirmation, and the original image is
   * never modified, so the action is not destructive.
   */
  function runRemoval({ body, state, report, bytes, url, altText }) {
    ui.renderPanel(body, { ...state, phase: 'working' });

    // Processing is synchronous byte work. Yield once so the "Removing..."
    // state actually paints before the main thread is busy.
    setTimeout(() => {
      let result;
      try {
        result = processorModule.removeCredentials(bytes, {
          removeXmpProvenanceReference: settings.removeXmpProvenanceReference,
        });
      } catch (error) {
        console.warn('[CrediClean] Processing failed.', error);
        ui.renderPanel(body, { ...state, phase: 'error', message: 'Please try again.' });
        return;
      }

      if (!result.ok) {
        // Technical detail goes to the console only; the user gets plain words.
        console.warn('[CrediClean] Not processed:', result.outcome, result.message);
        ui.renderPanel(body, {
          ...state,
          phase: 'error',
          message:
            result.outcome === OUTCOME.VERIFICATION_FAILED
              ? 'The result failed our checks, so nothing was saved. Your original is untouched.'
              : 'Please try again.',
        });
        return;
      }

      const filename = downloadManager.buildFilename({ url, format: report.format, altText });
      const saved = downloadManager.downloadBytes(result.output, filename, report.format);
      if (!saved.ok) {
        console.warn('[CrediClean] Download failed:', saved.error);
        ui.renderPanel(body, { ...state, phase: 'error', message: 'The file could not be saved.' });
        return;
      }

      // Only now, with the file written, report success.
      ui.renderPanel(body, { ...state, phase: 'saved' });
    }, 16);
  }

  /* --------------------------------------------------------------------- */
  /* Start, stop, and react to settings changes                             */
  /* --------------------------------------------------------------------- */

  function start() {
    if (watcher) return;
    overlay.mount();
    buttons = new ui.ButtonManager({ overlay, onInspect: handleInspect });
    watcher = new detector.ImageWatcher((entries) => {
      if (!settings.enabled || !settings.showImageButtons) return;
      buttons.attach(entries);
    });
    watcher.start();
  }

  function stop() {
    if (watcher) {
      watcher.stop();
      watcher = null;
    }
    if (buttons) {
      buttons.detachAll();
      buttons = null;
    }
    overlay.unmount();
  }

  function applySettings(next) {
    settings = next;
    if (settings.enabled && settings.showImageButtons) start();
    else stop();
  }

  settingsModule.onSettingsChanged(applySettings);
  applySettings(settings);
})();
