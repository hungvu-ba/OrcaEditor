/**
 * Ctrl+F (search.ts) caches the TreeWalker haystack between keystrokes of the
 * QUERY, and the deferred-work log carried a finding that this cache goes stale
 * on a local edit exactly the way US-9.3 Feature A's did in select-highlight.ts.
 * Measured 2026-07-28: **it does not**, and this file records the measurement so
 * the finding is not re-investigated a third time.
 *
 * Two facts close it:
 *
 *  1. `segs` maps an absolute haystack offset to a live Text node plus a
 *     node-relative offset, and the painted Range is built from the
 *     node-relative one. An edit in an EARLIER node shifts the cached segment
 *     start and the cached match offset by the same amount, so it still
 *     resolves correctly — only a mutation of the matched node itself could
 *     desynchronize it.
 *  2. To mutate the matched node the user needs focus in `#content`, and the
 *     only real way to move focus there from the search input is a click, which
 *     search.ts's click-outside handler treats as a close: `close()` clears the
 *     highlights and resets `query`, so no cached haystack is ever consumed
 *     afterwards. Probed directly — after a click in `#content` the box reports
 *     hidden. The remaining route, a keystroke, fires `input`, and main.ts's
 *     input handler already calls `search.refresh()`.
 *
 * No production change was needed. The test below instead guards fact 2's
 * keyboard half — `main.ts`'s `search.refresh()` in the input handler, the one
 * call the correctness rests on, which had no test naming it. It is deliberately
 * driven with a PROGRAMMATIC selection rather than a click, because a click would
 * close the box and the test would then pass for the wrong reason.
 *
 * Mutation-verified: deleting that `search.refresh()` call turns this red 3/3,
 * and restoring it green 3/3. Two earlier drafts of this test passed WITHOUT it
 * (see the oracle notes on `highlightedRanges` and in the test body) — do not
 * weaken either assertion.
 *
 * One route was NOT ruled out and has no test here: an async diagram render
 * (PlantUML/mermaid) replacing a `<pre>` after first paint mutates `#content`
 * with neither a click nor an `input` event, and does not go through
 * `scheduleSync()` either. It would need the MutationObserver fix the original
 * finding proposed. Not reproduced — the damage is a stale highlight over
 * diagram SOURCE text that self-corrects on the next query change, and driving
 * third-party render timing was judged not worth it. Revisit only with a report.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

type PWPage = import('@playwright/test').Page;

/** Collapsed caret at the very start of the paragraph whose full text is `pText`, and focus `#content`. */
async function caretAtStartOfParagraph(page: PWPage, pText: string): Promise<void> {
  await page.locator('#content').evaluate((el, text) => {
    const p = Array.from(el.querySelectorAll('p')).find((n) => n.textContent === text)!;
    const range = document.createRange();
    range.setStart(p.firstChild!, 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    el.focus();
  }, pText);
}

/**
 * Wait until some range in either search highlight reads exactly `expected`.
 * Both are checked because which one holds a given match depends on the match
 * count: with a single match `search-match` is dropped and only the current
 * one (`search-current`) is set.
 */
async function waitForSearchHighlight(page: PWPage, expected: string, timeoutMs = 2000): Promise<void> {
  await page.waitForFunction(
    (text) => {
      const all = CSS as unknown as { highlights: Map<string, Iterable<Range>> };
      for (const name of ['search-current', 'search-match']) {
        const hl = all.highlights.get(name);
        if (hl && Array.from(hl).some((r) => r.toString() === text)) {
          return true;
        }
      }
      return false;
    },
    expected,
    { timeout: timeoutMs }
  );
}

/**
 * Every range currently painted by either search highlight, as `text` plus
 * whether its container is still inside the live `#content`.
 *
 * `text` ALONE is not a valid oracle here, and an earlier version of this test
 * was vacuous for exactly that reason: when a stale segment's Text node has been
 * detached, the detached node still holds its PRE-edit content, so
 * `range.toString()` happily returns "target" for a range that paints nothing on
 * screen. Both stale outcomes have to be rejected — a live node at a shifted
 * offset (wrong text, `inContent: true`) and a detached node at the old offset
 * (right text, `inContent: false`).
 */
async function highlightedRanges(page: PWPage): Promise<{ text: string; inContent: boolean }[]> {
  return page.evaluate(() => {
    const all = CSS as unknown as { highlights: Map<string, Iterable<Range>> };
    const content = document.getElementById('content')!;
    const out: { text: string; inContent: boolean }[] = [];
    for (const name of ['search-current', 'search-match']) {
      const hl = all.highlights.get(name);
      if (hl) {
        for (const r of Array.from(hl)) {
          out.push({ text: r.toString(), inContent: content.contains(r.startContainer) });
        }
      }
    }
    return out;
  });
}

test('Ctrl+F re-resolves its match after a keystroke edit inside the matched paragraph', async ({ page }) => {
  // "target" occurs once, in the second paragraph, and the edit lands in THAT
  // paragraph ahead of the match — the only shape that could desynchronize the
  // cached node-relative offset (see fact 1 in the header).
  await openEditor(page, 'Alpha one\n\nBravo target two\n');

  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.locator('#search-box')).toBeVisible();
  await page.locator('#search-input').fill('target');
  await waitForSearchHighlight(page, 'target');

  // Programmatic caret + real keystrokes: focus reaches #content without a
  // click, so the box stays open and the cache is genuinely reused.
  await caretAtStartOfParagraph(page, 'Bravo target two');
  await page.keyboard.type('ZEBRA');
  await expect(page.locator('#content')).toContainText('ZEBRABravo target two');
  await expect(page.locator('#search-box')).toBeVisible();

  // Now search for the text that was JUST typed. This is the oracle, and it has
  // to be a string that did not exist before the edit: re-running the ORIGINAL
  // query cannot distinguish a fresh haystack from a stale one for the first
  // ~250ms, because the previously painted range is still correct until the
  // input debounce fires and repaints it from stale offsets — a poll that lands
  // in that window passes against the old paint. "ZEBRA" has no such window: on
  // a stale haystack it is simply absent and NOTHING is painted.
  await page.locator('#search-input').fill('ZEBRA');

  await expect(async () => {
    expect(await highlightedRanges(page)).toEqual([{ text: 'ZEBRA', inContent: true }]);
  }).toPass({ timeout: 3000 });
});
