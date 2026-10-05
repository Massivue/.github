# CrediClean privacy notice

Last updated: 4 October 2026. Applies to version 0.1.0.

## The short version

CrediClean does not collect anything. Your images, prompts and conversations
are never sent to us, because there is no "us" to send them to: the extension
has no server, no account system and no analytics.

## What the extension does on your computer

When you click the **CC** button on an image:

1. It downloads that one image from OpenAI's servers, the same file your
   browser is already showing you.
2. It reads the file's structure inside your browser to find provenance
   metadata.
3. If you ask it to, it writes out a copy with that metadata removed and saves
   it to your downloads folder.

Steps 2 and 3 happen entirely inside your browser. No image data leaves your
computer at any point.

## Network requests

CrediClean makes exactly one kind of network request: downloading an image you
clicked on, from `chatgpt.com`, `chat.openai.com` or `*.oaiusercontent.com`.

It makes no other requests. It contacts no third party. It loads no remote code,
no fonts, no trackers and no analytics.

## What is stored

Three settings: whether the extension is on, whether to show buttons on
images, and whether to remove linked XMP data.

These are stored with Chrome's `storage.sync` API, which means Chrome may sync
them between your own signed-in Chrome installations. They contain no personal
information. Nothing else is stored: no history of images you have inspected,
no file contents, no addresses.

Uninstalling the extension removes them.

## Permissions, and why each one is needed

| Permission | Why |
|---|---|
| `storage` | To remember the three settings above. |
| `https://chatgpt.com/*`, `https://chat.openai.com/*` | To show buttons on images in your conversation, and to read the image file. |
| `https://*.oaiusercontent.com/*` | ChatGPT serves image files from this domain, so the extension needs to read from it to get the file you clicked on. |

CrediClean does **not** request access to your browsing history, your cookies,
your passwords, other websites, or your tabs in general.

It does not request the `downloads` permission. Files are saved using an
ordinary browser download triggered by your click, which needs no special
access.

## Contact

Raise an issue on the repository where you obtained this extension.
