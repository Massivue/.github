/**
 * Popup logic: show whether the extension is active, and edit the settings.
 *
 * Deliberately small. The popup does no image work and reads nothing from the
 * page beyond the current tab's address, which it uses only to tell the user
 * whether they are on ChatGPT.
 */

import { loadSettings, saveSettings } from '../shared/settings.js';
import { CHATGPT_HOSTS } from '../shared/constants.js';

const fields = {
  enabled: document.getElementById('setting-enabled'),
  showImageButtons: document.getElementById('setting-buttons'),
  removeXmpProvenanceReference: document.getElementById('setting-xmp'),
};

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const savedNote = document.getElementById('saved-note');

let savedTimer = null;
function flashSaved() {
  savedNote.hidden = false;
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    savedNote.hidden = true;
  }, 1400);
}

function isChatGptUrl(url) {
  if (!url) return false;
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== 'https:') return false;
    return CHATGPT_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

async function describeStatus(settings) {
  if (!settings.enabled) {
    statusDot.classList.remove('status__dot--on');
    statusText.textContent = 'Turned off';
    return;
  }

  let onChatGpt = false;
  try {
    /*
     * Deliberately NOT requesting the "tabs" permission.
     *
     * `tabs.query` works without it. The catch is that `tab.url` is only filled
     * in for tabs whose address matches one of our host_permissions. That is
     * exactly what we want: we get the address for ChatGPT tabs, and
     * `undefined` for every other site, which `isChatGptUrl` correctly reads as
     * "not ChatGPT". Adding "tabs" would let us read the address of every tab
     * the user has open, for no gain, and would show a scarier install warning.
     */
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    onChatGpt = isChatGptUrl(tab && tab.url);
  } catch {
    onChatGpt = false;
  }

  if (onChatGpt) {
    statusDot.classList.add('status__dot--on');
    statusText.textContent = settings.showImageButtons
      ? 'Active on this page'
      : 'Active, image buttons hidden';
  } else {
    statusDot.classList.remove('status__dot--on');
    statusText.textContent = 'Ready. Open ChatGPT to use it.';
  }
}

async function init() {
  const settings = await loadSettings();

  for (const [key, input] of Object.entries(fields)) {
    if (!input) continue;
    input.checked = Boolean(settings[key]);
    input.addEventListener('change', async () => {
      const next = await saveSettings({ [key]: input.checked });
      flashSaved();
      await describeStatus(next);
    });
  }

  await describeStatus(settings);

  document.getElementById('open-chatgpt').addEventListener('click', async () => {
    await chrome.tabs.create({ url: 'https://chatgpt.com/' });
    window.close();
  });

  const version = chrome.runtime.getManifest().version;
  document.getElementById('version').textContent = `v${version}`;
}

init().catch((error) => {
  statusText.textContent = 'Could not load settings.';
  console.warn('[CrediClean] Popup failed to initialise.', error);
});
