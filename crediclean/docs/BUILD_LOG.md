# Build log

Version 0.1.0, built 4 October 2026.

## Milestone 1: Feasibility

**Goal:** find out whether this is possible at all before building anything.

Downloaded real C2PA-signed images from the Content Authenticity Initiative's
own test repositories and examined their bytes directly, rather than relying on
what articles said about the format.

That was the right call. A web search claimed PNG stores C2PA in an `iTXt`
chunk. The real file showed a **`caBX`** chunk, with `iTXt` holding something
else entirely (XMP). The specification confirmed `caBX`. Had we trusted the
search result, the PNG support would have been wrong from the start.

**Findings:**

- PNG keeps the manifest in a `caBX` chunk.
- JPEG keeps it in one or more `APP11` segments.
- Both are self-contained blocks that can simply be dropped.
- **This makes removal lossless.** No canvas redraw, no re-compression.
- `c2pa-js` can read and validate credentials but offers no way to remove them,
  so it was not used. Written up in `docs/FEASIBILITY.md` §7.

**Decision:** write the container handling by hand. No dependencies, no build
step, and the part that matters is testable against real files.

## Milestone 2: The processing engine

Built format detection, PNG/JPEG/WebP container parsing, a JUMBF box reader,
the inspector and the remover.

**Verified:** ran real signed images through it and confirmed with
**ImageMagick** that the output had zero differing pixels, unchanged
dimensions, and no credentials left. Confirmed by hash that the originals were
untouched.

**A real bug, caught here:** a manifest too large for one JPEG segment is split
across several, and the reader was only reading as far as the first. Found only
because the test used a real signed file rather than one we had built
ourselves. Fixed by reassembling the pieces before reading, after confirming
the exact splitting rule from the real file's bytes.

## Milestone 3: The extension

Built the service worker, image loader, DOM detector, overlay, panel, popup,
settings and packaging.

Two design decisions worth recording:

- **Nothing is inserted into ChatGPT's own elements.** ChatGPT is a React
  application and would tear our controls out when it re-renders. Controls live
  in a separate layer positioned over the images instead.
- **Everything is in a shadow root**, so ChatGPT's styling cannot affect our
  controls and ours cannot affect their interface.

## Milestone 4: Testing

Unit tests all passing, 13 of them against real signed images.

Then, unexpectedly, a **real browser test**: Chromium is available in this
environment, so the extension is loaded into it for real, with `chatgpt.com`
pointed at a local server serving a reconstruction of ChatGPT's markup. 37
checks, covering the whole workflow from button to downloaded file.

**Two more real bugs, both found here, both would have shipped:**

1. **The panel vanished when the page scrolled.** Controls hide when their
   image leaves the screen, which is right for small buttons and wrong for a
   panel someone is reading. Fixed: panels stay on screen and are clamped into
   view.

2. **The panel closed itself the instant a file downloaded.** Downloading works
   by clicking a hidden link; that click travelled up the page and the panel
   read it as "clicked away", closing before the success message appeared.
   Fixed by containing the click.

A usability problem was also found and fixed: on a long report the action
buttons sat below the fold, so the panel's action row is now pinned to the
bottom.

## Milestone 5: Live confirmation, simplification and a real bug fix

**5 October 2026.**

The product owner installed version 0.1.0 in Chrome and ran it against the real
ChatGPT. The button appeared on a generated image and Content Credentials were
correctly detected. That closed the one gap the build could not close itself.

Two problems came out of that first real use.

### The service worker was throwing on every install

`chrome://extensions` showed an error:

> Uncaught (in promise) TypeError: import() is disallowed on
> ServiceWorkerGlobalScope by the HTML specification.

The cause was a dynamic `await import('../shared/constants.js')` inside the
`onInstalled` handler. Dynamic import is forbidden in a service worker.

The fix was small because the architecture was already right: the worker is
declared `"type": "module"`, and two static imports at the top of the file were
working fine. The two names the handler needed were folded into one of them and
the dynamic import deleted. No manifest change, no new architecture, nothing
suppressed.

The handler had been failing silently in the sense that the extension still
worked, but the default settings were never seeded on install. The test for
this now checks exactly that: after a fresh install, the defaults must be in
storage, which can only happen if the handler ran to its end.

### The panel was a developer tool, not a consumer one

It showed the manifest contents, the assertion labels, the signer, the
verification checks and three paragraphs of caveats. It was 506px tall and
scrolled. It also asked for confirmation twice.

Rewritten to show one status line, three facts (format, size, filename) and one
button. 392px wide, 256px tall, no scrolling. The second confirmation is gone
entirely: the labelled button is the confirmation, and since the original image
is never modified, the action is not destructive.

One short line of caveat was kept, carrying the single fact most often got
wrong: that removing metadata does not touch watermarks inside the picture.
Everything else technical was removed.

The browser test grew from 37 checks to 58, and now asserts the absence of the
technical sections as explicitly as it asserts the presence of the three facts,
so the panel cannot quietly grow back into an inspector.

## Where things stand

**Working and verified:**

- Inspecting and removing credentials in PNG and JPEG, losslessly.
- Independent confirmation of losslessness (ImageMagick, zero differing pixels).
- The complete workflow in a real browser, through to a verified download.
- 95 unit tests and 58 browser checks, all passing.
- Minimum permissions, checked against the code automatically.

**Implemented but not verified:**

- **WebP removal.** No real C2PA-signed WebP could be found to test against.
  Written from the specification and passing our own tests only.

**Confirmed on the live site:**

- Detection and inspection were verified by the product owner against the real
  ChatGPT on 5 October 2026.

**Still only tested against a reconstruction:**

- The removal-and-download path on the live site, and behaviour across many
  different conversation layouts.

**Deliberately not built:**

- Signature validation. `c2pa-js` could do it but would roughly double the
  extension's size for a feature nobody asked for. The product therefore never
  claims a credential is valid, only that one is present.
