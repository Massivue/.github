# Four-platform support research

Written 5 October 2026 for CrediClean 0.2.0.

## How to read this document

Every claim below is labelled:

- **Confirmed by us** — we inspected real bytes or tested it ourselves.
- **Vendor-documented** — the vendor says so, and we have read a summary of
  their page but could not open the page itself.
- **Not confirmed** — we could not establish it. Treated as unknown.

### Two limitations on this research, stated up front

1. **We could not generate images on Gemini, Copilot or Grok.** This build
   environment has no accounts for them. Everything about those three is
   research plus testing against a reconstruction, not a real file.
2. **The network here blocks several vendor domains.** `blog.google` and
   `support.microsoft.com` could not be opened, so the Gemini and Copilot
   findings come from search-result summaries **of** those first-hand pages,
   not from the pages themselves. That is weaker evidence and is labelled
   "vendor-documented" rather than confirmed.

## The thing that matters most

**C2PA metadata and invisible watermarks are different things, and CrediClean
only handles the first.**

| | What it is | Can CrediClean remove it? |
|---|---|---|
| C2PA Content Credentials | A signed block of data inside the file | **Yes**, and verifiably |
| SynthID (Google) | A pattern hidden in the pixels | **No**, and we do not try |
| Visible logo (Grok) | Part of the picture itself | **No**, and we do not try |

An image that has been through CrediClean has had its metadata removed. It has
not been made untraceable, and the product never says otherwise.

---

## ChatGPT

| Item | Finding |
|---|---|
| Domain | `chatgpt.com`, `chat.openai.com` — **confirmed by us** |
| Image host | `*.oaiusercontent.com`, and `chatgpt.com/backend-api/...` — **confirmed by us** |
| How images are shown | Ordinary `<img>` inside a `[data-message-author-role]` element — **confirmed by us** |
| Retrieving the original | Fetch the signed URL in `src`/`srcset`. The URLs are short-lived — **confirmed by us** |
| Format | PNG and WebP — **vendor-documented** |
| C2PA | Present — **confirmed by us**, by the product owner on the live site |
| Other provenance | OpenAI documents watermarking alongside C2PA — **vendor-documented** |
| Detection | Working — **confirmed by us** |
| Processing | Working, losslessly — **confirmed by us** |
| Local only | Yes — **confirmed by us** |

**Limitations:** image URLs expire, so a stale tab may fail to fetch. Nothing
else known.

---

## Google Gemini

| Item | Finding |
|---|---|
| Domain | `gemini.google.com` — **vendor-documented** |
| Image host | `lh3.googleusercontent.com` and similar — **confirmed by the product owner's test**, which reached a Google CDN address |
| How images are shown | **Not confirmed.** Adapter targets `model-response` / `message-content` elements |
| Retrieving the original | Same mechanism as ChatGPT, assuming the host is reachable — **not confirmed** |
| Format | **Not confirmed** |
| C2PA | Gemini-app images carry C2PA manifests — **vendor-documented** |
| Other provenance | **SynthID**, an invisible pixel watermark — **vendor-documented** |
| Detection | **Confirmed working** on the live site: the button appears and the panel opens |
| Processing | Engine is shared with ChatGPT, so it will work on any C2PA file — **not confirmed** for Gemini files specifically |
| Local only | Yes, by construction |

### The resized-derivative problem, and the fix

On 5 October 2026 a real Gemini image reported "No supported credentials
found". Detection was working; retrieval was not.

**Cause:** Google serves images through a resizing CDN. The address in the page
ends with an options string such as `=w526-h296-rw`, asking for a particular
width, height and format. What comes back is a **derivative** that the CDN
re-encoded on the fly, and a re-encoded copy carries none of the original's
C2PA manifest. Inspecting it will always report nothing found, however correct
the credential engine is.

**Fix:** the Gemini adapter now rewrites the options to `=s0`, which asks for
the original at original resolution and format, and tries that first. The
address from the page is kept as a fallback, so if the rewrite is ever wrong
the extension behaves exactly as it did before rather than breaking.

`=s0` is **an inference, not vendor-documented**. Google does not publish this
as an API, though the convention is well established and widely corroborated.
The fallback is what makes relying on it safe.

A browser test reproduces the whole failure: the mock page shows a stripped
derivative and serves the signed original only at `=s0`, so the test fails
unless the adapter genuinely asks for the original.

**The SynthID point, because it is the one most likely to mislead a user:**
Google applies both C2PA metadata and SynthID. CrediClean removes the first.
The second stays in the pixels and Google's detector will still find it. This
is expected and is not a failure of the removal. The adapter records this fact
in `knownUnremovableProvenance` so the project cannot lose track of it.

**Main remaining risk:** whether the `=s0` original itself carries C2PA. If
Google strips credentials from everything its CDN serves, no address will have
them and the correct answer really is "none found". The built-in diagnosis
distinguishes these: see `docs/TROUBLESHOOTING.md`.

---

## Microsoft Copilot

| Item | Finding |
|---|---|
| Domain | `copilot.microsoft.com`, `designer.microsoft.com` — **vendor-documented** |
| Image host | **Not confirmed.** `th.bing.com` is Bing's long-standing image CDN and is the most likely, but this is an inference |
| How images are shown | **Not confirmed.** Adapter targets `[data-content="ai-message"]` and similar |
| Retrieving the original | **Not confirmed** |
| Format | **Not confirmed** |
| C2PA | Images created with Designer's features in Copilot carry Content Credentials based on C2PA — **vendor-documented** |
| Other provenance | **Not confirmed** |
| Detection | Implemented, **not confirmed** on the live site |
| Processing | Shared engine — **not confirmed** for Copilot files specifically |
| Local only | Yes, by construction |

**Note on surfaces:** Copilot image generation is reachable from more than one
place, and Bing Image Creator, Designer and Copilot share a generation
pipeline. The adapter claims the two Copilot/Designer domains. It does **not**
claim all of `bing.com` or `microsoft.com`, which would be a far broader
permission than this extension needs.

---

## Grok (xAI)

**This is the platform we are least sure about, and the product reflects that.**

| Item | Finding |
|---|---|
| Does Grok generate images | Yes, via Grok Imagine — **vendor-documented** |
| Domain | `grok.com`, and inside `x.com` — **vendor-documented** |
| Image host | **Not confirmed.** Expected `assets.grok.com` on grok.com and `pbs.twimg.com` within X |
| How images are shown | **Not confirmed** |
| Retrieving the original | **Not confirmed.** xAI documents that generated image URLs are temporary |
| Format | **Not confirmed** |
| **C2PA** | **NOT CONFIRMED. We could not establish this either way.** |
| Other provenance | A **visible corner logo**, which is part of the picture and not metadata — **vendor-documented** |
| Detection | Implemented, **not confirmed** |
| Processing | **Unknown.** The engine runs; whether it finds anything is unknown |

### Why Grok's C2PA status is recorded as unknown

We looked, and the evidence does not support a claim either way:

- **xAI publishes no documentation** stating that Grok attaches C2PA Content
  Credentials.
- **xAI is not on the C2PA steering committee**, unlike OpenAI.
- Reporting indicates xAI signed only the safety chapter of the EU's
  general-purpose AI code of practice and declined the transparency chapter.
- **The sources that state confidently that Grok uses C2PA are watermark
  removal services.** They sell a product whose value depends on that claim
  being true. That is a commercial interest, not evidence, and we did not rely
  on them.

### What the product does about it

Nothing invented. The Grok adapter finds the image and hands the bytes to the
same engine every other platform uses. Then:

- If a Grok image **does** carry supported credentials, they are detected and
  can be removed, exactly as elsewhere.
- If it **does not**, the panel says **"No supported credentials found"** and
  offers nothing to remove.

Both outcomes are correct. The second is not a bug, and it is the one our
reconstruction test deliberately exercises.

---

## Permissions, and why each exists

| Permission | Why |
|---|---|
| `storage` | Three settings |
| `chatgpt.com`, `chat.openai.com` | ChatGPT pages |
| `gemini.google.com` | Gemini pages |
| `copilot.microsoft.com`, `designer.microsoft.com` | Copilot pages |
| `grok.com`, `x.com` | Grok pages |
| `*.oaiusercontent.com` | ChatGPT image files — **confirmed** |
| `*.googleusercontent.com` | Expected Gemini image files. Cannot be narrowed: Google spreads user content across `lh3`, `lh4` and similar |
| `th.bing.com`, `*.bing.net` | Expected Copilot image files |
| `assets.grok.com`, `pbs.twimg.com` | Expected Grok image files |
| `usercontent.google.com` | Alternative Google user-content host |

Deliberately **not** requested: `<all_urls>`, all of `google.com`,
`microsoft.com` or `bing.com`, the `downloads` permission, the `tabs`
permission, history, cookies.

These are generated from `src/platforms/`, and `npm run verify` fails if the
manifest and the adapters ever disagree.

## What would change these findings

One real file from each platform. If you generate an image on Gemini, Copilot
or Grok, download it and send it, we can inspect the actual bytes and turn
most of the "not confirmed" rows above into confirmed ones in a single pass.
