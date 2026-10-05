/**
 * Reconstructed pages for each supported platform.
 *
 * IMPORTANT, AND THE WHOLE REASON THIS FILE CARRIES A WARNING:
 *
 * This markup is OUR RECONSTRUCTION of each site, built from the selectors in
 * the adapters. Passing these tests proves the adapter architecture, the
 * credential engine and the UI work together for a page shaped like this. It
 * does NOT prove the selectors match the real Gemini, Copilot or Grok, because
 * we have no accounts for them and have never seen their real markup.
 *
 * Only ChatGPT has been confirmed on the live site.
 */

/** Markup per platform, keyed by adapter id. */
export const PLATFORM_PAGES = {
  chatgpt: {
    host: 'chatgpt.com',
    body: `
      <header>
        <img id="avatar" src="/avatar/user.png" width="32" height="32" alt="Profile">
      </header>
      <main>
        <div data-message-author-role="user"><p>Draw me a picture.</p></div>
        <div data-message-author-role="assistant" data-testid="conversation-turn-2">
          <p>Here is your image.</p>
          <img id="generated" class="generated" src="/img?id=file-signed" alt="A generated picture">
        </div>
      </main>`,
  },

  gemini: {
    host: 'gemini.google.com',
    /*
     * This page reproduces the REAL Gemini behaviour, as diagnosed from a live
     * image on 5 October 2026.
     *
     * It downloads the genuine signed file, draws it to a canvas, and shows
     * the canvas output from a blob. That really does destroy the metadata,
     * exactly as the live page does: the diagnosed image was a JPEG with no
     * EXIF, no XMP and no APP11 segment.
     *
     * Crucially, and matching what the live page actually looks like, there is
     * NO link and NO attribute anywhere near the image holding the original's
     * address. Running the DOM snippet on the real page returned empty lists
     * for both. So the only route to the original is observing the download,
     * which is what this test exercises.
     *
     * A differently shaped decoy is fetched too, so the test also proves a
     * wrong recorded address is refused rather than processed.
     */
    imageHost: 'lh3.googleusercontent.com',
    body: `
      <header>
        <img id="avatar" src="https://lh3.googleusercontent.com/a/ACg8ocK-profile" width="32" height="32" alt="Account">
      </header>
      <main>
        <user-query><p>Draw me a picture.</p></user-query>
        <model-response>
          <message-content>
            <p>Here is your image.</p>
            <img id="generated" class="generated" alt="A generated picture">
          </message-content>
        </model-response>
      </main>
      <script>
        const REAL = 'https://lh3.googleusercontent.com/gg/REALID=s0';
        const DECOY = 'https://lh3.googleusercontent.com/gg/DECOYID=w300-h900';

        // A wrong-shaped image the page also downloads. Must be refused.
        fetch(DECOY).then((r) => r.blob()).catch(() => {});

        // The real file, then a canvas re-encode, exactly as Gemini does.
        fetch(REAL)
          .then((response) => response.blob())
          .then((blob) => createImageBitmap(blob))
          .then((bitmap) => {
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            canvas.getContext('2d').drawImage(bitmap, 0, 0);
            canvas.toBlob(
              (encoded) => {
                document.getElementById('generated').src = URL.createObjectURL(encoded);
              },
              'image/jpeg',
              0.92,
            );
          })
          .catch(() => {});
      </script>`,
  },

  copilot: {
    host: 'copilot.microsoft.com',
    body: `
      <header>
        <img id="avatar" src="/avatar/me.png" width="32" height="32" alt="Account">
      </header>
      <main>
        <div data-testid="message" data-content="user-message"><p>Draw me a picture.</p></div>
        <div data-testid="message" data-content="ai-message">
          <p>Here is your image.</p>
          <img id="generated" class="generated" src="/img?id=file-signed" alt="A generated picture">
        </div>
      </main>`,
  },

  grok: {
    host: 'grok.com',
    body: `
      <header>
        <img id="avatar" src="/profile_images/1/me.jpg" width="32" height="32" alt="Account">
      </header>
      <main>
        <div role="log">
          <p>Here is your image.</p>
          <!-- Grok is the platform where we do NOT know whether credentials
               exist, so its page serves an image with none. The panel must say
               so plainly and offer nothing to remove. -->
          <img id="generated" class="generated" src="/img?id=file-unsigned" alt="A generated picture">
        </div>
      </main>`,
  },
};

export function pageHtml(platform) {
  const page = PLATFORM_PAGES[platform];
  return `<!doctype html>
<html lang="en" class="dark">
<head><meta charset="utf-8"><title>Mock ${platform}</title>
<style>
  body { background:#212121; color:#ececf1; font-family:system-ui; margin:0; }
  header { display:flex; align-items:center; gap:8px; padding:12px; }
  main { max-width:760px; margin:0 auto; padding:24px 24px 160px; }
  img.generated { max-width:100%; border-radius:12px; display:block; }
  #composer { position:fixed; bottom:0; left:0; right:0; height:120px;
    background:#303030; border-top:1px solid #444; display:flex;
    align-items:center; justify-content:center; z-index:5; }
  #composer input { width:60%; padding:14px; border-radius:24px; border:0; }
</style></head>
<body>
  ${page.body}
  <div id="composer"><input placeholder="Ask something"></div>
</body></html>`;
}
