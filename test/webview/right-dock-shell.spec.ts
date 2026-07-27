/**
 * Req 23 US-23.7 (goal A) — the shared right-dock tab container shell.
 *
 * Covers: the panel renders as the `TOC` tab inside a tab strip with correct
 * `tablist`/`tab`/`tabpanel` ARIA and a single tab stop (AC1, AC6); `#toc-toggle`
 * opens on the `TOC` tab (AC4); the `⋯` button renders exactly when the active
 * tab has registered items (AC5); Escape closes the container but only after
 * a higher-priority surface has had its turn (AC6); the container keeps the
 * shipped docked-right geometry (AC1, AC3); mutual exclusion with US-23.4's
 * `#comment-panel` still holds (AC9).
 *
 * Not covered here, and deliberately so — see the deferred-work entry for
 * US-23.7: tab switching, ←/→ traversal and last-tab restore are unobservable
 * with a single registered tab. The `⋯` menu now has items (US-10.8's depth
 * control), so its per-item behaviour is exercised in toc-filter.spec.ts; the
 * priority-table assertion below guards the menu's Escape ordering.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';

const DOC = `# Alpha

Drains the queue in order.

## Beta

Second section body text.

# Gamma

Third section body text.
`;

/** Everything after the first heading deleted, so the thread floats (US-23.4 tier 4). */
const GUTTED = '# Alpha\n';

async function openDock(page: Page): Promise<void> {
  // force: toolbar overflow math can transiently report #toc-toggle as offscreen.
  await page.locator('#toc-toggle').click({ force: true });
  await expect(page.locator('#toc-panel')).toHaveCSS('width', '300px');
}

test('the panel renders as the TOC tab inside a tab strip with tablist semantics', async ({ page }) => {
  await openEditor(page, DOC);
  await openDock(page);

  const strip = page.locator('#toc-panel .right-dock-tabs');
  await expect(strip).toHaveCSS('height', '32px');

  // The tablist is an inner element so the `⋯` button can be its sibling: a
  // `tablist` may only own `tab` children.
  const tablist = strip.locator('.right-dock-tablist');
  await expect(tablist).toHaveAttribute('role', 'tablist');
  await expect(tablist.locator('> *:not([role="tab"])')).toHaveCount(0);

  const tab = page.locator('.right-dock-tab');
  await expect(tab).toHaveCount(1);
  await expect(tab).toHaveAttribute('role', 'tab');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(tab).toHaveText('TOC');

  // Single tab stop: the active tab is the only reachable header.
  await expect(tab).toHaveAttribute('tabindex', '0');

  const bodyId = await tab.getAttribute('aria-controls');
  expect(bodyId).toBe('toc-tabpanel');
  const body = page.locator('#toc-tabpanel');
  await expect(body).toHaveAttribute('role', 'tabpanel');
  await expect(body).toHaveAttribute('aria-labelledby', (await tab.getAttribute('id'))!);
  await expect(body).toBeVisible();

  // The TOC's own content came along and still renders.
  await expect(page.locator('#toc-tabpanel #toc-list .toc-item')).toHaveCount(3);
});

test('the ⋯ button renders because the TOC tab registers menu items, and its menu starts closed', async ({ page }) => {
  await openEditor(page, DOC);
  await openDock(page);

  // US-10.8 registers the TOC tab's depth items, which is what puts the button in
  // the strip; AC5's "absent when there are no items" branch is enforced by
  // updateMenuButton() running from activate(), and stays observable the moment a
  // second, item-less tab registers (US-23.9).
  await expect(page.locator('.right-dock-menu-btn')).toHaveCount(1);
  // The menu node exists (built once at dock creation) but stays hidden until asked.
  await expect(page.locator('.right-dock-menu')).toHaveCount(1);
  await expect(page.locator('.right-dock-menu')).toBeHidden();

  await page.locator('.right-dock-menu-btn').click();
  await expect(page.locator('.right-dock-menu')).toBeVisible();
  await expect(page.locator('.right-dock-menu-title')).toHaveText('Outline depth');
});

test('an inactive tabpanel is really hidden — an author display must not defeat [hidden]', async ({ page }) => {
  await openEditor(page, DOC);
  await openDock(page);

  // #toc-tabpanel carries `display: flex`, and an author declaration outranks the
  // UA's [hidden] { display: none } at any specificity. Without the dock's own
  // override the panel would still paint when a second tab (US-23.9) takes over,
  // so assert the override directly rather than waiting for that tab to exist.
  const hiddenDisplay = await page.locator('#toc-tabpanel').evaluate((el) => {
    el.toggleAttribute('hidden', true);
    const display = getComputedStyle(el).display;
    el.toggleAttribute('hidden', false);
    return display;
  });
  expect(hiddenDisplay).toBe('none');
  await expect(page.locator('#toc-tabpanel')).toBeVisible();
});

test('the container keeps the shipped docked-right geometry', async ({ page }) => {
  await openEditor(page, DOC);
  const closedRight = await page.locator('#select-overview').evaluate((el) => getComputedStyle(el).right);
  expect(closedRight).toBe('0px');

  await openDock(page);

  // Right-offset mechanism is unchanged: the rulers still sit exactly one panel
  // width in, and the strip did not widen the reservation.
  await expect(page.locator('#select-overview')).toHaveCSS('right', '300px');
  await expect(page.locator('#search-overview')).toHaveCSS('right', '300px');
  await expect(page.locator('#search-box')).toHaveCSS('right', '320px');
  await expect(page.locator('body')).toHaveCSS('padding-right', '326px');
});

test('AC8: the strip and its menu re-tint and re-scale with Reading Mode', async ({ page }) => {
  await openEditor(page, DOC, {
    readability: { enabled: true, mode: 'sepia', fontFamily: '', zen: false },
  });
  await openDock(page);

  // The strip lives inside #toc-panel, so it inherits the mode's --toc-* chrome
  // tokens; assert against the panel rather than a hardcoded sepia value, so this
  // tracks the palette instead of duplicating it.
  const panelBg = await page.locator('#toc-panel').evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect(page.locator('.right-dock-tabs')).toHaveCSS('background-color', panelBg);

  // Rail chrome scales with the reading UI size (the outline-row precedent),
  // rather than staying at the OS-chrome 11px beside outline rows that grew.
  const [tabSize, itemSize] = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.fontSize = 'var(--reading-ui-fs-11)';
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).fontSize;
    probe.remove();
    const tab = getComputedStyle(document.querySelector('.right-dock-tab')!).fontSize;
    return [tab, expected];
  });
  expect(tabSize).toBe(itemSize);
});

test('the escape-priority table keeps in-tab surfaces ahead of the container', async ({ page }) => {
  await openEditor(page, DOC);
  const tiers = await page.evaluate(
    () =>
      (
        window as unknown as {
          EscapeStackDebug: { ESCAPE_PRIORITY: Record<string, number> };
        }
      ).EscapeStackDebug.ESCAPE_PRIORITY
  );
  expect(tiers.DOCK_MENU).toBeGreaterThan(tiers.DOCK);
  expect(tiers.NESTED_POPUP).toBeGreaterThan(tiers.DOCK_MENU);
  // No two tiers may share a value — registration order would decide the winner.
  const values = Object.values(tiers);
  expect(new Set(values).size).toBe(values.length);
});

test('Escape closes the container only when focus is inside it, and hands focus back', async ({ page }) => {
  await openEditor(page, DOC);
  await openDock(page);

  // Focus in the document: Escape must fall through untouched. The escape stack
  // is capture-phase on document and stopPropagation's the moment a handler
  // consumes, so a container handler that fired on "panel is open" alone would
  // swallow Escape from every listener still bound to its own element — the
  // Ctrl+F box, the TeX editor, toolbar popovers, the drag-handle menu.
  await page.locator('#content').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#toc-panel')).toHaveCSS('width', '300px');

  // Focus inside the container: now Escape owns it.
  await page.locator('.right-dock-tab').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#toc-panel')).toHaveCSS('width', '0px');
  // Focus must not be orphaned on a control inside a panel that is collapsing
  // and will go visibility:hidden.
  await expect(page.locator('#content')).toBeFocused();
  // Every other close path syncs the toolbar button; this one must too.
  await expect(page.locator('#toc-toggle')).not.toHaveClass(/\bactive\b/);
});

test('the Ctrl+F box still owns Escape while the container is open', async ({ page }) => {
  await openEditor(page, DOC);
  await openDock(page);

  await page.keyboard.press('Control+f');
  await expect(page.locator('#search-box')).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(page.locator('#search-box')).toBeHidden();
  await expect(page.locator('#toc-panel')).toHaveCSS('width', '300px');
});

test('a comment popover consumes Escape and leaves the container open', async ({ page }) => {
  await openEditor(page, DOC);
  await addComment(page, 0, 'Why in order?');
  await openDock(page);

  await page.locator('.comment-gutter-pin').first().click();
  await expect(page.locator('.comment-popover')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.comment-popover')).toBeHidden();
  await expect(page.locator('#toc-panel')).toHaveCSS('width', '300px');
});

test('the container and #comment-panel still never dock at once', async ({ page }) => {
  await openEditor(page, DOC);
  await addComment(page, 0, 'Why in order?');
  await hostUpdate(page, GUTTED);
  await expect(page.locator('#comment-panel-toggle')).toBeVisible();

  await openDock(page);
  await page.locator('#comment-panel-toggle').click();
  await expect(page.locator('#comment-panel')).toHaveCSS('width', '300px');
  await expect(page.locator('#toc-panel')).toHaveCSS('width', '0px');

  await page.locator('#toc-toggle').click({ force: true });
  await expect(page.locator('#toc-panel')).toHaveCSS('width', '300px');
  await expect(page.locator('#comment-panel')).toHaveCSS('width', '0px');
});

/** Select the first three characters of paragraph `pIndex` and comment on them. */
async function addComment(page: Page, pIndex: number, body: string): Promise<void> {
  await page.locator('#content').evaluate((el, index) => {
    const node = el.querySelectorAll('p')[index].firstChild!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 3);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, pIndex);
  await page.locator('#content').dispatchEvent('contextmenu', { clientX: 120, clientY: 120 });
  await page.locator('.comment-menu-item', { hasText: 'Add Comment' }).click();
  await page.locator('.comment-composer-input').fill(body);
  await page.locator('.comment-composer-submit').click();

  // The pin only renders once the host confirms the create, so echo the result
  // back the way provider.ts does (same handshake as comment-panel.spec).
  const create = await page.evaluate(
    () =>
      (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted
        .filter((m) => m.type === 'createComment')
        .at(-1)!
  );
  await page.evaluate(
    (requestId) =>
      window.postMessage(
        {
          type: 'createCommentResult',
          requestId,
          ok: true,
          author: 'reviewer',
          timestamp: new Date(2026, 6, 24, 10, 12).toISOString(),
        },
        '*'
      ),
    create.requestId
  );
  await expect(page.locator('.comment-gutter-pin')).toHaveCount(1);
}

/** Replace the document from the host side, the way an external edit arrives. */
async function hostUpdate(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => window.postMessage({ type: 'update', text: value }, '*'), text);
  await page.waitForTimeout(450);
}
