/**
 * Builds and manages CrediClean's on-page controls: the small button that sits
 * on each generated image, and the panel that opens when it is used.
 *
 * SECURITY NOTE: strings such as the claim generator and the assertion labels
 * are read out of the image file, which means they are untrusted input. Every
 * one of them is written with `textContent`, never `innerHTML`, so a crafted
 * image cannot inject markup or script into the page.
 */

import { STATUS } from '../processing/metadata-inspector.js';
import { ASSERTION_EXPLANATIONS, PRODUCT_NAME } from '../shared/constants.js';
import { HANDLED_ATTRIBUTE } from './image-detector.js';

const STATUS_TEXT = {
  [STATUS.CREDENTIALS_DETECTED]: {
    title: 'Content Credentials found',
    tone: 'found',
  },
  [STATUS.NO_CREDENTIALS_DETECTED]: {
    title: 'No supported credentials found',
    tone: 'clear',
  },
  [STATUS.UNSUPPORTED_FORMAT]: {
    title: 'This image format is not supported',
    tone: 'warn',
  },
  [STATUS.UNREADABLE]: {
    title: 'This image could not be inspected',
    tone: 'warn',
  },
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export class ButtonManager {
  /**
   * @param {object} args
   * @param {import('./overlay.js').Overlay} args.overlay
   * @param {(entry: {img: HTMLImageElement, url: string}, ui: object) => void} args.onInspect
   */
  constructor({ overlay, onInspect }) {
    this.overlay = overlay;
    this.onInspect = onInspect;
    this.badges = new Map(); // img -> badge element
    this.openPanel = null;
  }

  /** Give every entry a button, skipping any that already has a live one. */
  attach(entries) {
    for (const entry of entries) {
      const existing = this.badges.get(entry.img);
      if (existing && existing.isConnected) continue;
      if (existing) this.badges.delete(entry.img);
      this.createBadge(entry);
    }
    this.overlay.pruneDetached();
    this.cleanupStaleBadges();
  }

  cleanupStaleBadges() {
    for (const [img, badge] of this.badges) {
      if (!img.isConnected) {
        this.overlay.remove(badge);
        this.badges.delete(img);
      }
    }
  }

  detachAll() {
    for (const [img, badge] of this.badges) {
      this.overlay.remove(badge);
      if (img.removeAttribute) img.removeAttribute(HANDLED_ATTRIBUTE);
    }
    this.badges.clear();
    this.closePanel();
  }

  createBadge(entry) {
    const badge = element('button', 'cc-badge');
    badge.type = 'button';
    badge.setAttribute('aria-label', `Inspect image credentials with ${PRODUCT_NAME}`);
    badge.title = `${PRODUCT_NAME}: inspect this image's Content Credentials`;

    const mark = element('span', 'cc-badge__mark', 'CC');
    mark.setAttribute('aria-hidden', 'true');
    const label = element('span', 'cc-badge__label', 'Inspect credentials');
    const spinner = element('span', 'cc-badge__spinner');
    spinner.setAttribute('aria-hidden', 'true');

    badge.append(mark, label, spinner);

    badge.addEventListener('click', (event) => {
      // Stop the click reaching ChatGPT, which would open its image viewer.
      event.preventDefault();
      event.stopPropagation();
      this.handleBadgeClick(entry, badge, label);
    });

    entry.img.setAttribute(HANDLED_ATTRIBUTE, 'true');
    this.badges.set(entry.img, badge);
    this.overlay.add(badge, entry.img, 'bottom-left');
  }

  handleBadgeClick(entry, badge, label) {
    if (badge.dataset.busy === 'true') return;

    const ui = {
      setBusy: (busy, text) => {
        badge.dataset.busy = busy ? 'true' : 'false';
        badge.classList.toggle('cc-badge--busy', busy);
        badge.setAttribute('aria-busy', busy ? 'true' : 'false');
        label.textContent = text || (busy ? 'Working...' : 'Inspect credentials');
      },
      showPanel: (build) => this.showPanel(entry, build),
      closePanel: () => this.closePanel(),
    };

    this.onInspect(entry, ui);
  }

  showPanel(entry, build) {
    this.closePanel();

    const panel = element('div', 'cc-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `${PRODUCT_NAME} credential report`);
    panel.tabIndex = -1;

    const header = element('div', 'cc-panel__header');
    const brand = element('div', 'cc-panel__brand');
    brand.append(element('span', 'cc-panel__mark', 'CC'), element('span', null, PRODUCT_NAME));
    const close = element('button', 'cc-panel__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.closePanel();
    });
    header.append(brand, close);

    const body = element('div', 'cc-panel__body');
    panel.append(header, body);

    panel.addEventListener('click', (event) => event.stopPropagation());
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.closePanel();
      }
    });

    this.openPanel = { panel, img: entry.img, body };
    this.overlay.add(panel, entry.img, 'panel');
    build(body, { close: () => this.closePanel() });
    panel.focus({ preventScroll: true });

    // Clicking anywhere else closes the panel. Clicks that originate inside
    // our own overlay are retargeted by the shadow boundary to the host
    // element, so they are identified and ignored here rather than relying
    // only on stopPropagation further down.
    const handler = (event) => {
      if (event.target === this.overlay.host) return;
      this.closePanel();
    };
    this.outsideClickHandler = handler;
    // Deferred by a tick so the click that opened this panel does not
    // immediately close it again. The handler is captured in a local so a
    // panel closed before the tick cannot register a later panel's handler.
    setTimeout(() => {
      if (this.outsideClickHandler === handler) document.addEventListener('click', handler);
    }, 0);

    return this.openPanel;
  }

  closePanel() {
    if (this.outsideClickHandler) {
      document.removeEventListener('click', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
    if (this.openPanel) {
      this.overlay.remove(this.openPanel.panel);
      this.openPanel = null;
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Panel content builders                                                     */
/* ------------------------------------------------------------------------- */

/** Render a short error state. */
export function renderError(body, message) {
  body.replaceChildren();
  body.append(statusBlock('warn', 'Something went wrong', message));
}

/** Render the inspection report. */
export function renderReport(body, report, actions) {
  body.replaceChildren();

  const descriptor = STATUS_TEXT[report.status] || STATUS_TEXT[STATUS.UNREADABLE];
  const summary =
    report.status === STATUS.CREDENTIALS_DETECTED
      ? 'This image carries embedded Content Credentials describing where it came from.'
      : report.status === STATUS.NO_CREDENTIALS_DETECTED
        ? 'We did not find any Content Credentials in the places this extension knows how to look.'
        : report.structureError || 'No further detail is available.';

  body.append(statusBlock(descriptor.tone, descriptor.title, summary));

  // File facts.
  const facts = element('dl', 'cc-facts');
  addFact(facts, 'Format', report.formatLabel);
  if (report.dimensions) {
    addFact(facts, 'Size', `${report.dimensions.width} x ${report.dimensions.height} pixels`);
  }
  addFact(facts, 'File', formatBytes(report.byteLength));
  body.append(facts);

  if (report.status === STATUS.CREDENTIALS_DETECTED) {
    body.append(renderCredentialDetail(report));
  }

  if (report.otherMetadata.length > 0) {
    const section = element('div', 'cc-section');
    section.append(element('h3', 'cc-section__title', 'Other metadata'));
    const list = element('ul', 'cc-list');
    for (const entry of report.otherMetadata) {
      const item = element('li', null, `${entry.label} (${formatBytes(entry.bytes)})`);
      if (entry.hasProvenanceReference) {
        item.append(element('span', 'cc-tag', 'links to the credential'));
      }
      list.append(item);
    }
    section.append(list);
    body.append(section);
  }

  for (const warning of report.warnings) {
    body.append(element('p', 'cc-note cc-note--warn', warning));
  }

  body.append(renderHonestyNote(report));

  if (actions) body.append(actions);
}

function renderCredentialDetail(report) {
  const section = element('div', 'cc-section');
  section.append(element('h3', 'cc-section__title', 'What was found'));

  const list = element('ul', 'cc-list');
  for (const location of report.c2pa.locations) {
    list.append(element('li', null, `${location.location} - ${formatBytes(location.bytes)}`));
  }
  if (report.c2pa.manifestCount > 0) {
    list.append(
      element(
        'li',
        null,
        report.c2pa.manifestCount === 1
          ? '1 credential record (manifest)'
          : `${report.c2pa.manifestCount} credential records (manifests)`,
      ),
    );
  }
  section.append(list);

  // Claim generator: the tool that signed the credential, read from the file.
  for (const generator of report.c2pa.claimGenerators) {
    const line = element('p', 'cc-note');
    line.append(element('strong', null, 'Signed by: '));
    line.append(document.createTextNode(generator));
    section.append(line);
  }

  if (report.c2pa.assertionLabels.length > 0) {
    section.append(element('h4', 'cc-section__subtitle', 'The credential states:'));
    const details = element('ul', 'cc-list cc-list--detail');
    for (const label of report.c2pa.assertionLabels) {
      const item = element('li');
      item.append(element('code', 'cc-code', label));
      const explanation = ASSERTION_EXPLANATIONS[label];
      if (explanation) item.append(element('span', 'cc-explain', explanation));
      details.append(item);
    }
    section.append(details);
  }

  return section;
}

/**
 * The honesty note. This is not decoration: it is the part that stops the
 * product overstating what it has done. Do not remove it.
 */
function renderHonestyNote(report) {
  const note = element('div', 'cc-honesty');
  if (report.status === STATUS.NO_CREDENTIALS_DETECTED) {
    note.append(
      element(
        'p',
        null,
        'This means no credentials were found in this file, in the places this version checks. It is not proof the image never had any.',
      ),
    );
  }
  note.append(
    element(
      'p',
      null,
      'Removing metadata does not remove any invisible watermark that may be present in the pixels themselves. CrediClean cannot see or change those.',
    ),
  );
  note.append(
    element(
      'p',
      null,
      'We check that a credential is present and read its labels. We do not check whether it is cryptographically valid.',
    ),
  );
  return note;
}

/** Render the outcome of a removal, including the verification checks. */
export function renderProcessed(body, result, filename) {
  body.replaceChildren();

  body.append(
    statusBlock(
      'clear',
      'Credentials removed and file saved',
      `Saved as ${filename}. Your original image on ChatGPT is unchanged.`,
    ),
  );

  const section = element('div', 'cc-section');
  section.append(element('h3', 'cc-section__title', 'What was removed'));
  const list = element('ul', 'cc-list');
  for (const item of result.removed) {
    const entry = element('li', null, `${item.label} - ${formatBytes(item.bytes)} (${item.location})`);
    if (item.note) entry.append(element('span', 'cc-explain', item.note));
    list.append(entry);
  }
  section.append(list);
  body.append(section);

  const checks = element('div', 'cc-section');
  checks.append(element('h3', 'cc-section__title', 'Checks run on the saved file'));
  const checkList = element('ul', 'cc-checks');
  for (const check of result.verification.checks) {
    const item = element('li', check.passed ? 'cc-check cc-check--pass' : 'cc-check cc-check--fail');
    item.append(element('span', 'cc-check__icon', check.passed ? '✓' : '✗'));
    const text = element('span');
    text.append(element('strong', null, check.name));
    text.append(element('span', 'cc-explain', check.detail));
    item.append(text);
    checkList.append(item);
  }
  checks.append(checkList);
  body.append(checks);

  body.append(
    element(
      'p',
      'cc-honesty',
      'Removing these credentials removes information about where the image came from. It does not make the image undetectable as AI-generated, and it does not affect any invisible watermark in the pixels.',
    ),
  );
}

export function statusBlock(tone, title, detail) {
  const block = element('div', `cc-status cc-status--${tone}`);
  block.append(element('div', 'cc-status__title', title));
  if (detail) block.append(element('div', 'cc-status__detail', detail));
  return block;
}

export function addFact(list, label, value) {
  list.append(element('dt', null, label));
  list.append(element('dd', null, value));
}

export { element as createElement, formatBytes };
