/**
 * Feature: Paste/Drop Image width round-trip (HLR mục 17, US-17.6/M4 + clipboard
 * paste). DOM-outcome tests: paste-image.ts's insertImageAt() (after the M5 fix
 * that awaits measureWidth() before the host round-trip, eliminating the old
 * measure-vs-save race) always inserts one of:
 *   - `<img src="..." alt="" width="N">` — measurement succeeded (paste or drop
 *     outside a table cell).
 *   - `<img src="..." alt="">` — measurement failed (decode() rejected); no
 *     width attribute, valid fallback (NOT the race — the race is what this
 *     fix removes).
 * This file simulates exactly those two outcome shapes and checks
 * serialize(DOM) → markdown matches expectations and is stable on a second
 * round-trip (render again, serialize again, same markdown). It does NOT call
 * insertImageAt()/requestSave() directly — those need a live document /
 * execCommand + host postMessage round-trip only available in a real webview,
 * not in domino.
 *
 * Chạy riêng: npm run test:roundtrip:paste-image
 */
import { Runner, serializeHtml, renderer } from './_lib';

const runner = new Runner();

interface DomCase {
  name: string;
  html: string;
  expect: (md: string) => boolean;
}

const domCases: DomCase[] = [
  {
    // Successful measurement path (measureWidth resolved before the host save
    // round-trip completed, guaranteed by the M5 async/await fix) — turndown's
    // htmlImgWithAttrs rule fires because `width` is an attribute beyond
    // src/alt/title, so the raw <img> tag (and its width) is preserved as-is
    // instead of being flattened into bare `![](...)` markdown.
    name: 'pasted image with measured width (US-17 paste) → raw <img width> preserved',
    html: '<p><img src="assets/pasted-image-1.png" alt="" width="480"></p>',
    expect: (md) =>
      md.includes('<img') &&
      md.includes('width="480"') &&
      md.includes('src="assets/pasted-image-1.png"') &&
      !md.includes('!['),
  },
  {
    // Measurement-failure fallback (e.g. probe.decode() rejected on a corrupt
    // blob) — no width attribute at all, so htmlImgWithAttrs does NOT match
    // (only src/alt present) and turndown falls through to the plain markdown
    // image rule. This is the legitimate fallback the fix still allows; it is
    // NOT the race this fix eliminates (the race used to also produce a
    // width-less <img> even when measurement would have succeeded, just too
    // late).
    name: 'pasted image with no measured width (decode failure fallback) → plain markdown image',
    html: '<p><img src="assets/pasted-image-2.png" alt=""></p>',
    expect: (md) => md.includes('![](assets/pasted-image-2.png)') && !md.includes('<img'),
  },
  {
    // Dropped image (US-17.6, M4) NOT inside a table cell (fillCell = false)
    // reuses the exact same insertImageAt() width path as clipboard paste.
    name: 'dropped image outside a table cell (US-17.6) → raw <img width> preserved same as paste',
    html: '<p><img src="assets/dropped-image-1.png" alt="" width="640"></p>',
    expect: (md) =>
      md.includes('<img') && md.includes('width="640"') && md.includes('src="assets/dropped-image-1.png"'),
  },
];

for (const c of domCases) {
  let ok = true;
  const problems: string[] = [];
  try {
    const md = serializeHtml(c.html);
    if (!c.expect(md)) {
      ok = false;
      problems.push(`Kết quả không như kỳ vọng: ${JSON.stringify(md)}`);
    }
    const md2 = serializeHtml(renderer.render(md).html);
    if (md2 !== md) {
      ok = false;
      problems.push(`Không ổn định: md=${JSON.stringify(md)} md2=${JSON.stringify(md2)}`);
    }
  } catch (e) {
    ok = false;
    problems.push(`Exception: ${(e as Error).stack}`);
  }
  runner.check(c.name, ok, problems.join('\n'));
}

runner.finish('paste-image');
