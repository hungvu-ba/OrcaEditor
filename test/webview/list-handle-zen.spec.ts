/**
 * DIAGNOSTIC (self-driven): reproduce the Zen-mode nested list handle offset.
 * Builds a multi-level list via real Tab-indent (malformed ul>ul), enables Zen,
 * then for every <li> synth-hovers its text and reads the actual .dd-li-handle
 * position vs the anchorLeft the code should compute. Logs everything.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';
import type { InitConfig } from '../../src/shared/messages';

const ZEN: InitConfig['readability'] = {
  enabled: true, preset: 'default', palette: 'followTheme', fontFamily: '', zen: true,
};

test('DIAGNOSTIC: multi-level Tab-indented list handle positions in Zen', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await openEditor(page, '- a\n- b\n- c\n- d', { readability: ZEN });
  const content = page.locator('#content');

  const caretIn = async (text: string) => {
    await content.evaluate((el, t) => {
      const li = [...el.querySelectorAll('li')].find((l) => l.textContent!.trim().startsWith(t))!;
      const r = document.createRange();
      r.setStart(li.firstChild!, 1);
      r.collapse(true);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    }, text);
  };

  await caretIn('b'); await content.press('Tab');               // b -> level 1
  await caretIn('c'); await content.press('Tab'); await content.press('Tab'); // c -> deeper
  await page.waitForTimeout(30);

  const info = await content.evaluate((el) => {
    const GAP = 26;
    return {
      contentClass: el.className,
      structure: el.innerHTML.replace(/ data-[^=]+="[^"]*"/g, '').replace(/>\s+</g, '><').slice(0, 260),
      lis: [...el.querySelectorAll('li')].map((li, i) => {
        const r = li.getBoundingClientRect();
        const ll = (li.parentElement as HTMLElement).getBoundingClientRect().left;
        return {
          i, text: (li.textContent || '').trim().slice(0, 6),
          left: +r.left.toFixed(1), top: +r.top.toFixed(1),
          parentTag: li.parentElement!.tagName,
          grandTag: li.parentElement!.parentElement?.tagName,
          listLeft: +ll.toFixed(1),
          anchorLeft: +Math.max(ll, r.left - GAP).toFixed(1),
        };
      }),
    };
  });
  console.log('[CONTENT.class]', info.contentClass);
  console.log('[STRUCT]', info.structure);
  console.log('[LIS]', JSON.stringify(info.lis));

  // Hover each li's own text; read the handle actually drawn.
  for (const li of info.lis) {
    await page.mouse.move(li.left + 12, li.top + 6);
    await page.waitForTimeout(30);
    const h = await page.locator('.dd-li-handle').evaluate((el) => {
      const disp = getComputedStyle(el).display;
      const r = el.getBoundingClientRect();
      return { disp, right: +r.right.toFixed(1), top: +r.top.toFixed(1), styleRight: el.style.right };
    }).catch(() => ({ disp: 'none', right: -1, top: -1, styleRight: '' }));
    const forLi = info.lis.find((L) => Math.abs(L.top - h.top) < 3);
    console.log(`[HOVER ${li.text}] at(${(li.left+12).toFixed(0)},${(li.top+6).toFixed(0)}) handle.right=${h.right} handle.top=${h.top} disp=${h.disp} -> handle-for="${forLi?.text}" (its anchorLeft=${forLi?.anchorLeft})`);
  }
  expect(true).toBe(true);
});
