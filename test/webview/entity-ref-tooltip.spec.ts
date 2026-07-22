/**
 * Req 21 — entity-scope.ts hover tooltip on an entity-reference pill
 * (`a.md-entity-ref`): `id[ preview][ in location]`.
 *
 * The preview is the text following the `caption::NS_ID` declaration token
 * (truncated by the shared rule), so a bare namespace code is understandable at
 * a glance. Two resolution paths, keyed off the href's file part:
 *  - Same-document mention (`#UC01`): preview read straight from the declaration
 *    badge's following text node in the DOM; location = nearest enclosing entity.
 *  - Cross-file mention (`file.md#UC01`): location = the target file; the preview
 *    comes from the host's `entitiesExistResult` reply (cached by the broken-ref
 *    scan's round trip) and is absent until that reply lands.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

interface CheckEntitiesExistMsg {
  type: 'checkEntitiesExist';
  requestId: number;
  docVersion: number;
  ids: string[];
}

const DOC = [
  'caption::Test1 top-level namespace.',
  '',
  '## Section',
  '',
  'caption::UC01 Submit Leave Request',
  '',
  'See [UC01](SAMPLE_EN_JP.md#UC01) cross-file and [UC01](#UC01) same-file.',
  '',
].join('\n');

/** Hover the entity-ref's text (mousemove-driven, rAF-coalesced) and read the rendered tooltip text. */
async function tooltipTextFor(page: import('@playwright/test').Page, href: string): Promise<string> {
  return page.evaluate(
    (h) =>
      new Promise<string>((resolve) => {
        const a = document.querySelector(`#content a.md-entity-ref[href="${h}"]`) as HTMLElement;
        const r = a.getBoundingClientRect();
        // Hover the text (well past the ~16px leading warning-triangle hitzone).
        a.dispatchEvent(
          new MouseEvent('mousemove', { bubbles: true, clientX: r.left + r.width - 4, clientY: r.top + r.height / 2 })
        );
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const tip = document.querySelector('#toolbar-tooltip') as HTMLElement | null;
            resolve(tip && tip.style.display !== 'none' ? (tip.textContent ?? '') : '');
          })
        );
      }),
    href
  );
}

/** Reply to the broken-ref scan's `checkEntitiesExist` so the cross-file preview cache is populated. */
async function replyWithPreview(page: import('@playwright/test').Page, id: string, preview: string): Promise<void> {
  const handle = await page.waitForFunction(() =>
    (window as unknown as { __posted: CheckEntitiesExistMsg[] }).__posted.find((m) => m.type === 'checkEntitiesExist')
  );
  const req = (await handle.jsonValue()) as CheckEntitiesExistMsg;
  await page.evaluate(
    ({ requestId, docVersion, id, preview }) =>
      window.postMessage(
        { type: 'entitiesExistResult', requestId, docVersion, results: [{ id, exists: true, occurrences: 1, preview }] },
        '*'
      ),
    { requestId: req.requestId, docVersion: req.docVersion, id, preview }
  );
}

test('same-document mention tooltip shows the following-text preview + enclosing entity', async ({ page }) => {
  await openEditor(page, DOC);
  await page.waitForSelector('#content a.md-entity-ref');
  expect(await tooltipTextFor(page, '#UC01')).toBe('UC01 Submit Leave Request in Test1');
});

test('cross-file mention tooltip names the target file (no preview before the host reply)', async ({ page }) => {
  await openEditor(page, DOC);
  await page.waitForSelector('#content a.md-entity-ref');
  expect(await tooltipTextFor(page, 'SAMPLE_EN_JP.md#UC01')).toBe('UC01 in SAMPLE_EN_JP.md');
});

test('cross-file mention tooltip adds the host-supplied preview once it arrives', async ({ page }) => {
  await openEditor(page, DOC);
  await page.waitForSelector('#content a.md-entity-ref');
  await replyWithPreview(page, 'UC01', 'Submit Leave Request');
  expect(await tooltipTextFor(page, 'SAMPLE_EN_JP.md#UC01')).toBe('UC01 Submit Leave Request in SAMPLE_EN_JP.md');
});
