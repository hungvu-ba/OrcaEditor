/**
 * US-2.7 redesign: front matter as a collapsed one-line row (default) /
 * expanded card / raw YAML, with real click interactions (toggle, RAW, copy)
 * and in-session state persistence across a re-render. Needs the real webview
 * engine — test/roundtrip/ (domino) only covers DOM-stability + serialization,
 * not click events, navigator.clipboard, or renderDocument()'s re-render path.
 *
 * US-2.9 added the js-yaml cases below: value shapes the hand-rolled scanner
 * could not represent (nested list/map, block scalar, deeper structure),
 * canonical display of dates/numbers/booleans, and the two behaviours it
 * deliberately changed — duplicate keys resolve last-wins, and YAML that fails
 * to parse degrades to verbatim raw rows instead of the invalid error frame.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

const MULTI_FIELD = '---\ntitle: Sample Document\ntype: spec\nstatus: draft\ncreated: 2026-07-27\ntags: [a, b]\n---\n\n# Heading\n\nBody text.\n';
const TWO_FIELD = '---\ntitle: Small Doc\ncreated: 2026-07-27\n---\n\n# Heading\n';
const ONE_FIELD = '---\ntitle: One Field Doc\n---\n\n# Heading\n';
const EMPTY_FIELD = '---\n---\n\n# Heading\n';
const UNPARSABLE = '---\nthis has no colon\ntitle: still here\n---\n\n# Heading\n';

test('front matter is collapsed by default, no raw YAML visible', async ({ page }) => {
  await openEditor(page, MULTI_FIELD);
  const fm = page.locator('.md-front-matter');
  await expect(fm).toHaveAttribute('data-fm-view', 'collapsed');
  await expect(fm.locator('.md-fm-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(fm.locator('.md-fm-row-title')).toHaveText('Sample Document');
  await expect(fm.locator('.md-fm-body')).toBeHidden();
});

test('clicking the row expands the card with title/badges/grid; clicking again collapses it', async ({ page }) => {
  await openEditor(page, MULTI_FIELD);
  const fm = page.locator('.md-front-matter');

  await fm.locator('.md-fm-toggle').click();
  await expect(fm).toHaveAttribute('data-fm-view', 'expanded');
  await expect(fm.locator('.md-fm-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(fm.locator('.md-fm-body')).toBeVisible();
  await expect(fm.locator('.md-fm-title')).toHaveText('Sample Document');
  await expect(fm.locator('.md-fm-badges')).toContainText('spec');
  await expect(fm.locator('.md-fm-badges')).toContainText('draft');
  await expect(fm.locator('.md-fm-grid')).toContainText('tags');

  await fm.locator('.md-fm-toggle').click();
  await expect(fm).toHaveAttribute('data-fm-view', 'collapsed');
  await expect(fm.locator('.md-fm-body')).toBeHidden();
});

test('RAW toggles the body between the structured card and syntax-tinted YAML, header stays put', async ({ page }) => {
  await openEditor(page, MULTI_FIELD);
  const fm = page.locator('.md-front-matter');
  await fm.locator('.md-fm-toggle').click();

  const rawToggle = fm.locator('.md-fm-raw-toggle');
  await expect(rawToggle).toHaveAttribute('aria-pressed', 'false');
  await rawToggle.click();

  await expect(fm).toHaveAttribute('data-fm-raw', 'true');
  await expect(rawToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(fm.locator('.md-fm-body')).toBeHidden();
  await expect(fm.locator('.md-fm-raw-body')).toBeVisible();
  await expect(fm.locator('.md-fm-raw-body')).toContainText('title: Sample Document');
  // Header (topline) unaffected by RAW — no layout jump.
  await expect(fm.locator('.md-fm-topline')).toBeVisible();

  await rawToggle.click();
  await expect(fm).toHaveAttribute('data-fm-raw', 'false');
  await expect(fm.locator('.md-fm-body')).toBeVisible();
  await expect(fm.locator('.md-fm-raw-body')).toBeHidden();
});

test('Copy writes the fenced original YAML to the clipboard', async ({ page }) => {
  await openEditor(page, MULTI_FIELD);
  const fm = page.locator('.md-front-matter');
  await fm.locator('.md-fm-toggle').click();

  await page.evaluate(() => {
    (window as unknown as { __copied: string | null }).__copied = null;
    navigator.clipboard.writeText = (t: string) => {
      (window as unknown as { __copied: string | null }).__copied = t;
      return Promise.resolve();
    };
  });

  const copyBtn = fm.locator('.md-fm-copy');
  await copyBtn.click();
  const copied = await page.evaluate(() => (window as unknown as { __copied: string | null }).__copied);
  expect(copied).toBe('---\ntitle: Sample Document\ntype: spec\nstatus: draft\ncreated: 2026-07-27\ntags: [a, b]\n---');
  await expect(copyBtn).toHaveText('Copied');
});

test('expanded/raw state survives a re-render triggered by an edit elsewhere in the document', async ({ page }) => {
  await openEditor(page, MULTI_FIELD);
  const fm = page.locator('.md-front-matter');
  await fm.locator('.md-fm-toggle').click();
  await fm.locator('.md-fm-raw-toggle').click();
  await expect(fm).toHaveAttribute('data-fm-view', 'expanded');
  await expect(fm).toHaveAttribute('data-fm-raw', 'true');

  // Simulate the host pushing a doc change from elsewhere (e.g. another edit),
  // exactly like main.ts's 'update' message handler — this is what re-runs
  // renderDocument() and fully replaces #content's innerHTML.
  await page.evaluate((text) => window.postMessage({ type: 'update', text }, '*'), MULTI_FIELD.replace('Body text.', 'Edited body text.'));
  await expect(page.locator('#content')).toContainText('Edited body text.');

  const fmAfter = page.locator('.md-front-matter');
  await expect(fmAfter).toHaveAttribute('data-fm-view', 'expanded');
  await expect(fmAfter).toHaveAttribute('data-fm-raw', 'true');
  await expect(fmAfter.locator('.md-fm-toggle')).toHaveAttribute('aria-expanded', 'true');
});

test('a front matter block with only 2 fields still gets a working expand toggle', async ({ page }) => {
  await openEditor(page, TWO_FIELD);
  const fm = page.locator('.md-front-matter');
  await expect(fm).toHaveAttribute('data-fm-view', 'collapsed');
  await expect(fm.locator('.md-fm-row-title')).toHaveText('Small Doc');

  await fm.locator('.md-fm-toggle').click();
  await expect(fm).toHaveAttribute('data-fm-view', 'expanded');
  await expect(fm.locator('.md-fm-body')).toBeVisible();
  await expect(fm.locator('.md-fm-title')).toHaveText('Small Doc');
});

test('a front matter block with exactly 1 field still gets a working expand toggle', async ({ page }) => {
  await openEditor(page, ONE_FIELD);
  const fm = page.locator('.md-front-matter');
  await expect(fm).toHaveAttribute('data-fm-view', 'collapsed');

  await fm.locator('.md-fm-toggle').click();
  await expect(fm).toHaveAttribute('data-fm-view', 'expanded');
  await expect(fm.locator('.md-fm-body')).toBeVisible();
  await expect(fm.locator('.md-fm-title')).toHaveText('One Field Doc');
});

test('an empty front matter block (0 fields) still gets a working expand toggle', async ({ page }) => {
  await openEditor(page, EMPTY_FIELD);
  const fm = page.locator('.md-front-matter');
  await expect(fm).toHaveAttribute('data-fm-view', 'collapsed');
  await expect(fm.locator('.md-fm-count')).toHaveText('0 fields');

  await fm.locator('.md-fm-toggle').click();
  await expect(fm).toHaveAttribute('data-fm-view', 'expanded');
  await expect(fm.locator('.md-fm-body')).toBeVisible();
  await expect(fm.locator('.md-fm-grid')).toHaveCount(0);
});

test('unparsable YAML keeps the card and shows every source line verbatim, marked with the line parsing stopped at', async ({ page }) => {
  await openEditor(page, UNPARSABLE);
  const fm = page.locator('.md-front-matter');
  // Not the error frame: the block stays a normal, expandable card.
  await expect(fm).toHaveAttribute('data-fm-view', 'collapsed');
  await expect(fm.locator('.md-fm-error-line')).toHaveText('Line 2');
  // Rows are source lines, not fields the parser resolved.
  await expect(fm.locator('.md-fm-count')).toHaveText('2 lines');

  await fm.locator('.md-fm-toggle').click();
  await expect(fm).toHaveAttribute('data-fm-view', 'expanded');
  await expect(fm.locator('.md-fm-grid-row-raw')).toHaveCount(2);
  await expect(fm.locator('.md-fm-grid')).toContainText('this has no colon');
  await expect(fm.locator('.md-fm-grid')).toContainText('title: still here');
  // RAW and Copy still work on a block that failed to parse.
  await fm.locator('.md-fm-raw-toggle').click();
  await expect(fm.locator('.md-fm-raw-body')).toBeVisible();
});

test('a top-level value that is not a key/value map shows the invalid frame with no line label', async ({ page }) => {
  const TOP_LEVEL_LIST = '---\n- alpha\n- beta\n---\n\n# Heading\n';
  await openEditor(page, TOP_LEVEL_LIST);
  const fm = page.locator('.md-front-matter');
  await expect(fm).toHaveAttribute('data-fm-view', 'invalid');
  await expect(fm).toHaveAttribute('role', 'status');
  await expect(fm.locator('.md-fm-label-error')).toHaveText('FRONT MATTER — INVALID');
  // No source position exists, so a "Line 1" here would be a lie.
  await expect(fm.locator('.md-fm-error-line')).toHaveText('Not a key/value map');
  await expect(fm.locator('.md-fm-error-body')).toContainText('- alpha');
});

test('a duplicate key resolves last-wins instead of showing both values', async ({ page }) => {
  const DUPLICATE_STATUS = '---\ntitle: Dup Doc\nstatus: draft\nstatus: done\ncreated: 2026-07-27\n---\n\n# Heading\n';
  await openEditor(page, DUPLICATE_STATUS);
  const fm = page.locator('.md-front-matter');
  await expect(fm.locator('.md-fm-count')).toHaveText('3 fields');
  await fm.locator('.md-fm-toggle').click();
  await expect(fm.locator('.md-fm-badges')).toContainText('done');
  await expect(fm.locator('.md-fm-badges')).not.toContainText('draft');
});

test('a structure deeper than one level falls back to a compact JSON row carrying its key', async ({ page }) => {
  const NESTED_ARRAY = '---\ntitle: Nested Doc\nmatrix: [[a, b], [c, d]]\nstatus: draft\ncreated: 2026-07-27\n---\n\n# Heading\n';
  await openEditor(page, NESTED_ARRAY);
  const fm = page.locator('.md-front-matter');
  await fm.locator('.md-fm-toggle').click();
  await expect(fm.locator('.md-fm-grid-row-raw')).toContainText('matrix: [["a","b"],["c","d"]]');
  await expect(fm.locator('.md-fm-value-item')).toHaveCount(0);
});

test('a block-style list renders as a stacked value list, not a raw row', async ({ page }) => {
  const BLOCK_LIST = '---\ntitle: List Doc\ncategories:\n  - tutorial\n  - markdown\n---\n\n# Heading\n';
  await openEditor(page, BLOCK_LIST);
  const fm = page.locator('.md-front-matter');
  await fm.locator('.md-fm-toggle').click();
  await expect(fm.locator('.md-fm-grid')).toContainText('categories');
  await expect(fm.locator('.md-fm-value-item')).toHaveCount(2);
  await expect(fm.locator('.md-fm-value-item').first()).toHaveText('tutorial');
  await expect(fm.locator('.md-fm-grid-row-raw')).toHaveCount(0);
});

test('a one-level nested map renders as an indented sub-grid of its own key/value pairs', async ({ page }) => {
  const NESTED_MAP = '---\ntitle: Author Doc\nauthor:\n  name: Hung\n  email: h@example.com\n---\n\n# Heading\n';
  await openEditor(page, NESTED_MAP);
  const fm = page.locator('.md-front-matter');
  await fm.locator('.md-fm-toggle').click();
  const subgrid = fm.locator('.md-fm-subgrid');
  await expect(subgrid).toHaveCount(1);
  await expect(subgrid.locator('.md-fm-key')).toHaveCount(2);
  await expect(subgrid).toContainText('name');
  await expect(subgrid).toContainText('Hung');
  await expect(fm.locator('.md-fm-grid-row-raw')).toHaveCount(0);
});

test('a block scalar renders full-width and pre-wrapped, clamped so it cannot stretch the card', async ({ page }) => {
  const BLOCK_SCALAR = '---\ntitle: Scalar Doc\nsummary: |\n  alpha line\n  beta line\n---\n\n# Heading\n';
  await openEditor(page, BLOCK_SCALAR);
  const fm = page.locator('.md-front-matter');

  await fm.locator('.md-fm-toggle').click();
  const summaryCell = fm.locator('.md-fm-grid .md-fm-value-raw');
  await expect(summaryCell).toContainText('alpha line');
  await expect(summaryCell).toContainText('beta line');
  await expect(summaryCell).toHaveCSS('white-space', 'pre-wrap');
  await expect(summaryCell).toHaveCSS('overflow-y', 'hidden');
  expect(await summaryCell.evaluate((el) => getComputedStyle(el).maxHeight)).not.toBe('none');
});

test('a promoted key holding a block scalar keeps its remaining lines in the grid', async ({ page }) => {
  const PROMOTED_BLOCK = '---\ntitle: |\n  Promoted first line\n  kept second line\nother: x\n---\n\n# Heading\n';
  await openEditor(page, PROMOTED_BLOCK);
  const fm = page.locator('.md-front-matter');
  // The collapsed row and the card title take the first line only...
  await expect(fm.locator('.md-fm-row-title')).toHaveText('Promoted first line');

  await fm.locator('.md-fm-toggle').click();
  await expect(fm.locator('.md-fm-title')).toHaveText('Promoted first line');
  // ...but the rest must not vanish from the structured card.
  await expect(fm.locator('.md-fm-grid')).toContainText('kept second line');
});

test('a nested map child holding a block scalar drops to a raw row instead of clipping in a nowrap cell', async ({ page }) => {
  const NESTED_MULTILINE = '---\ntitle: Bio Doc\nauthor:\n  bio: |\n    line one\n    line two\n---\n\n# Heading\n';
  await openEditor(page, NESTED_MULTILINE);
  const fm = page.locator('.md-front-matter');
  await fm.locator('.md-fm-toggle').click();
  await expect(fm.locator('.md-fm-subgrid')).toHaveCount(0);
  await expect(fm.locator('.md-fm-grid-row-raw')).toContainText('author: {"bio":"line one\\nline two\\n"}');
});

test('an empty nested map renders a compact JSON row, not an empty sub-grid box', async ({ page }) => {
  const EMPTY_MAP = '---\ntitle: Empty Map Doc\nauthor: {}\n---\n\n# Heading\n';
  await openEditor(page, EMPTY_MAP);
  const fm = page.locator('.md-front-matter');
  await fm.locator('.md-fm-toggle').click();
  await expect(fm.locator('.md-fm-subgrid')).toHaveCount(0);
  await expect(fm.locator('.md-fm-grid-row-raw')).toHaveText('author: {}');
});

test('scalars are canonically reformatted for display: numbers, booleans and dates', async ({ page }) => {
  const CANON = '---\ntitle: Canon Doc\ncount: 007\nratio: 1.10\nflag: true\nwhen: 2025-10-31T02:00:00+07:00\n---\n\n# Heading\n';
  await openEditor(page, CANON);
  const fm = page.locator('.md-front-matter');
  await fm.locator('.md-fm-toggle').click();
  const values = fm.locator('.md-fm-grid .md-fm-value');
  // Exact text, not a substring — `007` also contains `7`, `1.10` also contains `1.1`.
  await expect(values.nth(0)).toHaveText('7');
  await expect(values.nth(1)).toHaveText('1.1');
  await expect(values.nth(2)).toHaveText('true');
  // Normalized to UTC — the previous calendar day for a +07:00 source offset.
  await expect(values.nth(3)).toHaveText('2025-10-30T19:00:00Z');
});

test('a date-only timestamp keeps its YYYY-MM-DD form in the meta slot', async ({ page }) => {
  await openEditor(page, MULTI_FIELD);
  const fm = page.locator('.md-front-matter');
  await fm.locator('.md-fm-toggle').click();
  await expect(fm.locator('.md-fm-badges')).toContainText('created 2026-07-27');
});

test('comment-only front matter stays a valid 0-field card instead of turning invalid', async ({ page }) => {
  const COMMENT_ONLY = '---\n# just a comment\n---\n\n# Heading\n';
  await openEditor(page, COMMENT_ONLY);
  const fm = page.locator('.md-front-matter');
  await expect(fm).toHaveAttribute('data-fm-view', 'collapsed');
  await expect(fm.locator('.md-fm-count')).toHaveText('0 fields');
  await fm.locator('.md-fm-toggle').click();
  await expect(fm.locator('.md-fm-body')).toBeVisible();
});

test('a promoted key with an empty value is demoted into the grid instead of vanishing', async ({ page }) => {
  const EMPTY_STATUS = '---\ntitle: Demoted Doc\nstatus:\ntype: spec\n---\n\n# Heading\n';
  await openEditor(page, EMPTY_STATUS);
  const fm = page.locator('.md-front-matter');
  await fm.locator('.md-fm-toggle').click();
  await expect(fm.locator('.md-fm-badge-status')).toHaveCount(0);
  await expect(fm.locator('.md-fm-grid')).toContainText('status');
});

test('a cyclic anchor renders a placeholder row instead of blanking the whole preview', async ({ page }) => {
  const CYCLIC = '---\ntitle: Cyclic Doc\nloop: &a\n  self: *a\n---\n\n# Heading\n';
  await openEditor(page, CYCLIC);
  const fm = page.locator('.md-front-matter');
  // The rest of the document still rendered.
  await expect(page.locator('#content h1')).toHaveText('Heading');
  await fm.locator('.md-fm-toggle').click();
  await expect(fm.locator('.md-fm-grid-row-raw')).toContainText('loop: <unserializable value>');
});

test('a blank title field falls back to the first non-blank scalar, like a missing title field', async ({ page }) => {
  const BLANK_TITLE = '---\ntitle:\ntype: spec\nstatus: draft\ncreated: 2026-07-27\n---\n\n# Heading\n';
  await openEditor(page, BLANK_TITLE);
  const fm = page.locator('.md-front-matter');
  await expect(fm.locator('.md-fm-row-title')).toHaveText('type: spec');
});

test('Copy label survives a rapid double-click instead of getting stuck on "Copied"', async ({ page }) => {
  await openEditor(page, MULTI_FIELD);
  const fm = page.locator('.md-front-matter');
  await fm.locator('.md-fm-toggle').click();
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.resolve();
  });

  const copyBtn = fm.locator('.md-fm-copy');
  await copyBtn.click();
  await copyBtn.click();
  await expect(copyBtn).toHaveText('Copied');
  await page.waitForTimeout(1400);
  await expect(copyBtn).toHaveText('Copy');
});

test('the Copy live region is visually hidden, not a visible line in the card', async ({ page }) => {
  await openEditor(page, MULTI_FIELD);
  const fm = page.locator('.md-front-matter');
  await fm.locator('.md-fm-toggle').click();
  const box = await fm.locator('.md-fm-live').boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(1);
  expect(box?.height ?? 0).toBeLessThanOrEqual(1);
});

test('a path-like fallback title inside the toggle button is never linkified (no nested <a> in <button>)', async ({ page }) => {
  const NO_TITLE_PATH_FALLBACK = '---\npath: docs/notes.md\ntype: spec\nstatus: draft\ncreated: 2026-07-27\n---\n\n# Heading\n';
  await openEditor(page, NO_TITLE_PATH_FALLBACK);
  const fm = page.locator('.md-front-matter');
  await expect(fm.locator('.md-fm-toggle .md-fm-row-title')).toHaveText('path: docs/notes.md');
  await expect(fm.locator('.md-fm-toggle a')).toHaveCount(0);
});
