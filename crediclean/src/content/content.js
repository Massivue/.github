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
      import(moduleUrl('shared/constants.js')),
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
    constants,
  ] = modules;

  const { STATUS } = inspectorModule;
  const { OUTCOME } = processorModule;

  let settings = await settingsModule.loadSettings();
  const overlay = new overlayModule.Overlay();
  let watcher = null;
  let buttons = null;

  /* --------------------------------------------------------------------- */
  /* The main action: read the image, inspect it, offer what we can do      */
  /* --------------------------------------------------------------------- */

  async function handleInspect(entry, badgeUi) {
    badgeUi.setBusy(true, 'Reading image...');

    const url = imageLoader.bestSourceUrl(entry.img);
    const loaded = await imageLoader.loadImageBytes(url);

    // The user may have scrolled the image away or switched conversation while
    // we were fetching. Do not draw a panel onto an image that has gone.
    if (!entry.img.isConnected) {
      badgeUi.setBusy(false);
      return;
    }

    if (!loaded.ok) {
      badgeUi.setBusy(false);
      badgeUi.showPanel((body) => ui.renderError(body, loaded.error || 'The image could not be read.'));
      return;
    }

    badgeUi.setBusy(true, 'Inspecting...');

    let report;
    try {
      report = inspectorModule.inspectImage(loaded.bytes);
    } catch (error) {
      console.warn('[CrediClean] Inspection failed.', error);
      badgeUi.setBusy(false);
      badgeUi.showPanel((body) => ui.renderError(body, 'This image could not be inspected.'));
      return;
    }

    badgeUi.setBusy(false);

    badgeUi.showPanel((body) => {
      const actions = buildActions({ entry, report, bytes: loaded.bytes, url, body });
      ui.renderReport(body, report, actions);

      if (loaded.bytes.length > constants.SIZE_LIMITS.WARN_BYTES) {
        body.append(
          ui.createElement(
            'p',
            'cc-note cc-note--warn',
            'This is a large image, so processing may take a moment.',
          ),
        );
      }
    });
  }

  /* --------------------------------------------------------------------- */
  /* Action buttons inside the panel                                        */
  /* --------------------------------------------------------------------- */

  function buildActions({ entry, report, bytes, url, body }) {
    const row = ui.createElement('div', 'cc-actions');

    const canRemove = report.status === STATUS.CREDENTIALS_DETECTED;

    if (canRemove) {
      const removeButton = ui.createElement('button', 'cc-button cc-button--primary', 'Remove credentials and save');
      removeButton.type = 'button';
      removeButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (settings.confirmBeforeProcessing) {
          showConfirmation({ entry, report, bytes, url, body, row });
        } else {
          runRemoval({ entry, report, bytes, url, body, trigger: removeButton });
        }
      });
      row.append(removeButton);
    }

    // Saving the file as-is is always available, and is the only option when
    // there is nothing to remove.
    const saveOriginal = ui.createElement(
      'button',
      'cc-button',
      canRemove ? 'Save unchanged copy' : 'Save a copy',
    );
    saveOriginal.type = 'button';
    saveOriginal.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const filename = downloadManager.buildFilename({
        url,
        format: report.format,
        altText: entry.img.getAttribute('alt') || '',
        suffix: '-copy',
      });
      const saved = downloadManager.downloadBytes(bytes, filename, report.format);
      body.replaceChildren();
      if (!saved.ok) {
        ui.renderError(body, saved.error || 'The file could not be saved.');
        return;
      }
      body.append(
        ui.statusBlock(
          'clear',
          'Unchanged copy saved',
          canRemove
            ? `Saved as ${filename}. This copy still contains its Content Credentials: nothing was removed.`
            : `Saved as ${filename}. No supported credentials were found, so nothing was removed.`,
        ),
      );
    });
    row.append(saveOriginal);

    return row;
  }

  function showConfirmation({ entry, report, bytes, url, body, row }) {
    row.replaceChildren();

    const warning = ui.createElement(
      'p',
      'cc-note cc-note--warn',
      'This will save a new copy with the Content Credentials removed. Removing them removes information about where the image came from. The original on ChatGPT is not changed.',
    );

    const confirm = ui.createElement('button', 'cc-button cc-button--primary', 'Yes, remove and save');
    confirm.type = 'button';
    confirm.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      runRemoval({ entry, report, bytes, url, body, trigger: confirm });
    });

    const cancel = ui.createElement('button', 'cc-button', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      body.replaceChildren();
      ui.renderReport(body, report, buildActions({ entry, report, bytes, url, body }));
    });

    row.append(confirm, cancel);
    row.before(warning);
  }

  function runRemoval({ entry, report, bytes, url, body, trigger }) {
    if (trigger) {
      trigger.disabled = true;
      trigger.textContent = 'Working...';
    }

    // Processing is synchronous byte work. Yield to the browser first so the
    // "Working..." label actually paints before we block the main thread.
    setTimeout(() => {
      let result;
      try {
        result = processorModule.removeCredentials(bytes, {
          removeXmpProvenanceReference: settings.removeXmpProvenanceReference,
        });
      } catch (error) {
        console.warn('[CrediClean] Processing failed.', error);
        ui.renderError(body, 'This image could not be processed.');
        return;
      }

      if (!result.ok) {
        const messages = {
          [OUTCOME.NOTHING_TO_REMOVE]: 'There were no supported credentials to remove.',
          [OUTCOME.UNSUPPORTED_FORMAT]: 'This image format is not supported.',
          [OUTCOME.UNREADABLE]: 'This image could not be read.',
          [OUTCOME.VERIFICATION_FAILED]:
            'The processed image did not pass our checks, so it was not saved. Your original is untouched.',
        };
        ui.renderError(body, messages[result.outcome] || result.message);
        return;
      }

      const filename = downloadManager.buildFilename({
        url,
        format: report.format,
        altText: entry.img.getAttribute('alt') || '',
      });

      const saved = downloadManager.downloadBytes(result.output, filename, report.format);
      if (!saved.ok) {
        ui.renderError(body, saved.error || 'The processed file could not be saved.');
        return;
      }

      // Only now, with the file written, do we report success.
      ui.renderProcessed(body, result, filename);
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
