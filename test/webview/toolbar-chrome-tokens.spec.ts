/**
 * US-4.25 — each reading mode drives the toolbar via its OWN dedicated
 * `--toolbar-*` token set (distinct from the content `--rp-*`), and the
 * "Common"/"Default" badge is an accent, not the flat `--vscode-badge` gray.
 * Needs a real engine: it asserts resolved computed colors from the real CSS.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

const PALETTES = ['reading-mode-sepia', 'reading-mode-paper'];

// Dedicated per-mode toolbar chrome (US-4.25/US-19.24), as resolved rgb().
const MODES = [
  { cls: 'reading-mode-sepia', bg: 'rgb(236, 224, 196)', badge: 'rgb(138, 75, 8)' },
  { cls: 'reading-mode-paper', bg: 'rgb(244, 244, 234)', badge: 'rgb(37, 84, 160)' },
];

test('each reading mode gives the toolbar its own dedicated chrome bg + accent badge', async ({ page }) => {
  await openEditor(page, '# hi');

  for (const m of MODES) {
    const got = await page.evaluate(
      ({ cls, all }) => {
        all.forEach((c) => document.body.classList.remove(c));
        document.body.classList.add(cls);
        const bg = getComputedStyle(document.querySelector('#toolbar')!).backgroundColor;
        // real badge element → exercises the .toolbar-popover-badge CSS rule, not a hand-set style.
        const badge = document.createElement('span');
        badge.className = 'toolbar-popover-badge';
        document.body.appendChild(badge);
        const badgeBg = getComputedStyle(badge).backgroundColor;
        badge.remove();
        return { bg, badgeBg };
      },
      { cls: m.cls, all: PALETTES },
    );
    expect(got.bg, `${m.cls} toolbar bg`).toBe(m.bg);
    expect(got.badgeBg, `${m.cls} badge accent`).toBe(m.badge);
  }
});

test('toolbar chrome is distinct from the reading content (sepia): #toolbar bg !== --rp-bg', async ({ page }) => {
  await openEditor(page, '# hi');
  const { toolbarBg, contentBg } = await page.evaluate(() => {
    document.body.className = 'reading-mode-sepia';
    const toolbarBg = getComputedStyle(document.querySelector('#toolbar')!).backgroundColor;
    // --rp-bg is the content palette bg; the toolbar must NOT merely inherit it.
    const probe = document.createElement('span');
    probe.style.background = 'var(--rp-bg)';
    document.body.appendChild(probe);
    const contentBg = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { toolbarBg, contentBg };
  });
  expect(toolbarBg).toBe('rgb(236, 224, 196)'); // #ece0c4 dedicated toolbar hue
  expect(toolbarBg).not.toBe(contentBg); // distinct from --rp-bg (#f7f3ea content)
});

test('followTheme badge follows the VS Code accent (--vscode-button-background), not the flat badge gray', async ({ page }) => {
  await openEditor(page, '# hi');
  const badgeBg = await page.evaluate(() => {
    document.body.className = ''; // no reading palette → default tokens
    document.documentElement.style.setProperty('--vscode-button-background', 'rgb(1, 2, 3)');
    const badge = document.createElement('span');
    badge.className = 'toolbar-popover-badge';
    document.body.appendChild(badge);
    const c = getComputedStyle(badge).backgroundColor;
    badge.remove();
    return c;
  });
  expect(badgeBg).toBe('rgb(1, 2, 3)');
});
