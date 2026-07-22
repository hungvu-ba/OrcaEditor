/**
 * NOT a test — a screenshot generator for the 0.9.0 feature guide. Drives the
 * real webview bundle and writes tight element-level PNGs into docs/features-0.9.0/.
 * Run: npx playwright test test/webview/zz-feature-shots.spec.ts
 */
import { test, type Page } from '@playwright/test';
import * as path from 'path';
import { openEditor } from './_harness';

const OUT = path.join(__dirname, '..', '..', 'docs', 'features-0.9.0');
const shot = (name: string) => path.join(OUT, `${name}.png`);

interface Posted { type: string; requestId?: number; }
interface EntityReply { namespace: string; id: string; file: string; line: number; title: string; }

async function replyLastEntitySearch(page: Page, entities: EntityReply[]): Promise<void> {
  await page.evaluate((entities) => {
    const posted = (window as unknown as { __posted: Posted[] }).__posted;
    const req = [...posted].reverse().find((m) => m.type === 'entitySearch');
    if (!req) throw new Error('no entitySearch posted');
    window.postMessage({ type: 'entityResult', requestId: req.requestId, ready: true, entities }, '*');
  }, entities);
}

async function caretAt(page: Page, paraText: string, atEnd: boolean): Promise<void> {
  await page.locator('#content').click();
  await page.locator('#content').evaluate((content, { paraText, atEnd }) => {
    const p = Array.from(content.querySelectorAll('p')).find((el) => el.textContent === paraText)
      ?? content.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(!atEnd);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, { paraText, atEnd });
}

test.use({ viewport: { width: 900, height: 640 } });

test('toolbar', async ({ page }) => {
  await openEditor(page, '# Doc\n\ntext');
  await page.locator('#toolbar').screenshot({ path: shot('01-toolbar') });
});

test('declaration-badge + entity-mention pill', async ({ page }) => {
  await openEditor(
    page,
    'The flow starts at caption::UC01 Submit Leave Request and ends on approval.\n\n' +
      'Related: [UC01 Submit Leave Request](specs.md#UC01) is triggered by the employee.\n'
  );
  await page.locator('.md-caption').first().screenshot({ path: shot('02-declaration-badge') });
  await page.locator('.md-entity-ref').first().screenshot({ path: shot('03-entity-mention-pill') });
});

test('at-mention popup', async ({ page }) => {
  await openEditor(page, 'Reference the use case here.');
  await caretAt(page, 'Reference the use case here.', false);
  await page.keyboard.type('@');
  await page.locator('.trigger-popup-pill', { hasText: 'Entities' }).click();
  await page.keyboard.type('UC');
  await replyLastEntitySearch(page, [
    { namespace: 'UC', id: '01', file: 'specs.md', line: 12, title: 'Submit Leave Request' },
    { namespace: 'UC', id: '02', file: 'specs.md', line: 40, title: 'Approve Leave Request' },
    { namespace: 'UC', id: '03', file: 'flows.md', line: 8, title: 'Cancel Leave Request' },
  ]);
  await page.locator('.trigger-popup-item').first().waitFor();
  await page.locator('.trigger-popup').screenshot({ path: shot('04-at-mention-popup') });
});

test('slash block menu', async ({ page }) => {
  await openEditor(page, 'first line');
  await caretAt(page, 'first line', true);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await page.locator('.trigger-popup-item').first().waitFor();
  await page.locator('.trigger-popup').screenshot({ path: shot('05-slash-block-menu') });
});

for (const mode of ['standard', 'sepia', 'paper'] as const) {
  test(`reading-mode-${mode}`, async ({ page }) => {
    await openEditor(
      page,
      '# Leave Request Flow\n\n' +
        'The employee submits caption::UC01 Submit Leave Request. ' +
        'The manager then reviews and approves it.\n\n' +
        '- Draft the request\n- Send for approval\n- Receive decision\n',
      { readability: { enabled: true, mode, fontFamily: '', zen: false } }
    );
    await page.locator('#content').screenshot({ path: shot(`06-reading-${mode}`) });
  });
}
