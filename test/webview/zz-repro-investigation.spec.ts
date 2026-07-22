/** TEMPORARY repro spec for bug investigation — DELETE after run. */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

type Posted = { type: string; requestId?: number; namespace?: string; query?: string };

async function waitForPosted(page: Page, type: string): Promise<Posted> {
  const handle = await page.waitForFunction(
    (t) => (window as unknown as { __posted: Posted[] }).__posted.filter((m) => m.type === t).at(-1),
    type
  );
  return (await handle.jsonValue()) as Posted;
}

async function caretToEndOfFirstP(page: Page): Promise<void> {
  await page.locator('#content').click();
  await page.locator('#content').evaluate((content) => {
    const p = content.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

test('BUG6 repro: @ after "text " — is the space before @ preserved on link insert?', async ({ page }) => {
  await openEditor(page, '# My Heading\n\nHello\n');
  await caretToEndOfFirstP(page);
  await page.keyboard.type(' @');
  await page.keyboard.type('My He');
  // single heading match; pick it via Enter
  await page.locator('.trigger-popup-item', { hasText: 'My Heading' }).first().waitFor();
  await page.keyboard.press('Enter');
  const text = await page.locator('#content p').first().textContent();
  console.log('BUG6 paragraph text after commit:', JSON.stringify(text));
  expect(text).toBe('Hello My Heading');
});

test('BUG7 repro: "a /" declare → UC → suggested id; where does the token land?', async ({ page }) => {
  await openEditor(page, 'a\n');
  await caretToEndOfFirstP(page);
  await page.keyboard.type(' /declare');
  await page.locator('.trigger-popup-item', { hasText: 'Declare entity' }).first().click();

  const nsReq = await waitForPosted(page, 'namespaceList');
  await page.evaluate(
    (req) =>
      window.postMessage(
        { type: 'namespaceListResult', requestId: req.requestId, ready: true, namespaces: [{ name: 'UC', count: 1 }] },
        '*'
      ),
    nsReq
  );
  await page.locator('.trigger-popup-item-label', { hasText: /^UC$/ }).first().click();

  const entReq = await waitForPosted(page, 'entitySearch');
  await page.evaluate(
    (req) =>
      window.postMessage(
        {
          type: 'entityResult',
          requestId: req.requestId,
          ready: true,
          entities: [{ namespace: 'UC', id: '01', file: 'file:///proj/Foo.md', line: 2, title: 'Alpha' }],
        },
        '*'
      ),
    entReq
  );
  await page.locator('.trigger-popup-item-label', { hasText: 'Declare UC02' }).first().waitFor();
  await page.keyboard.press('Enter');
  await expect(page.locator('.trigger-popup')).toBeHidden();
  const html = await page.locator('#content').innerHTML();
  const text = await page.locator('#content').textContent();
  console.log('BUG7 content text:', JSON.stringify(text));
  console.log('BUG7 content html:', html);
  const edits = await page.evaluate(() =>
    (window as unknown as { __posted: { type: string; text?: string }[] }).__posted
      .filter((m) => m.type === 'edit')
      .map((m) => m.text)
  );
  console.log('BUG7 posted edit texts:', JSON.stringify(edits, null, 2));
});
