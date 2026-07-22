/**
 * bug_General Mention Declare #5: the `caption::NS_ID` declaration pill hides
 * the internal `caption::` prefix and shows `namespace value` as two spans with
 * a CSS gap — while keeping the badge's textContent === the literal token so the
 * document round-trips byte-identical (that byte-identity is proven in
 * test/roundtrip/caption-insert.ts; here we assert the RENDERED result under a
 * real browser with the real markdown.css/editor.css applied).
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

test('declaration pill hides "caption::" and shows namespace + value split', async ({ page }) => {
  await openEditor(page, 'caption::UC1');

  const badge = page.locator('#content .md-caption');
  await expect(badge).toHaveCount(1);

  // textContent is still the literal token (byte-identical serialization).
  expect(await badge.evaluate((el) => el.textContent)).toBe('caption::UC1');

  // namespace + value are shown as separate spans.
  await expect(badge.locator('.md-caption-ns')).toHaveText('UC');
  await expect(badge.locator('.md-caption-id')).toHaveText('1');

  // the internal `caption::` prefix is hidden from view.
  const prefixDisplay = await badge.locator('.md-caption-prefix').evaluate((el) => getComputedStyle(el).display);
  expect(prefixDisplay).toBe('none');

  // the gap between namespace and value is a real CSS margin, not a space char.
  const gapPx = await badge.locator('.md-caption-id').evaluate((el) => parseFloat(getComputedStyle(el).marginLeft));
  expect(gapPx).toBeGreaterThan(0);

  // the pill is a non-editable atom (#6/#7).
  await expect(badge).toHaveAttribute('contenteditable', 'false');

  // #1: Outline-capsule design tokens — transparent fill, 1.5px accent border +
  // accent label, fully-rounded, bold.
  const tokens = await badge.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      borderRadius: s.borderTopLeftRadius,
      fontWeight: s.fontWeight,
      borderWidth: s.borderTopWidth,
      background: s.backgroundColor,
      // border color and text color are the same per-theme accent.
      borderColor: s.borderTopColor,
      color: s.color,
    };
  });
  expect(tokens.borderRadius).toBe('999px');
  expect(tokens.fontWeight).toBe('700');
  // A visible border exists (exact sub-pixel width is rounded by getComputedStyle,
  // so assert presence, not the literal 1.5px).
  expect(parseFloat(tokens.borderWidth)).toBeGreaterThan(0);
  expect(tokens.background).toBe('rgba(0, 0, 0, 0)');
  expect(tokens.borderColor).toBe(tokens.color);
});
