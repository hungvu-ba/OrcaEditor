/**
 * P0.3 (HLR 22, execCommand List/Block Verb Replacement — Code Plan Phase 0):
 * asserts the CLEAN DOM shape each replaced verb must produce once the shared
 * compute-then-commit-via-insertHTML primitive (Phase 1/2) replaces the raw
 * execCommand call. These are RED today (`test.fail()` — Playwright's "expected
 * to fail" marker, so the suite stays green while the gap is explicit) against
 * the malformed shapes locked in by list-verbs-audit.spec.ts; as each Phase-2
 * sub-step replaces its site, remove that test's `test.fail()` wrapper so it
 * starts asserting for real. A test in here unexpectedly passing today would
 * itself be reported as a failure by Playwright — that's the signal Phase 2 for
 * that verb is already done and the wrapper can come off.
 *
 * Valid nested list shape: `li > ul` (never `ul > ul` sibling). No block should
 * ever end up nested inside a leftover `<p>` (`p > ul`/`p > ol`). No styling-only
 * `<span style="...">` artifact should be left behind by outdent.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

function placeCaretInItem(el: HTMLElement, itemText: string): void {
  const li = [...el.querySelectorAll('li')].find((l) => l.textContent!.includes(itemText))!;
  const r = document.createRange();
  r.setStart(li.firstChild!, 1);
  r.collapse(true);
  const s = window.getSelection()!;
  s.removeAllRanges();
  s.addRange(r);
}

test.fail('indent (Tab) produces li > ul, not ul > ul', async ({ page }) => {
  await openEditor(page, '- Alpha\n- Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Bravo');
  await content.press('Tab');
  const facts = await content.evaluate((el) => ({
    ulInUl: !!el.querySelector('ul > ul'),
    liInUl: !!el.querySelector('li > ul'),
  }));
  expect(facts.ulInUl).toBe(false);
  expect(facts.liInUl).toBe(true);
});

test.fail('outdent (Shift+Tab) leaves no empty <ul> and no styling-span artifact', async ({ page }) => {
  await openEditor(page, '- Alpha\n  - Bravo');
  const content = page.locator('#content');
  await content.evaluate(placeCaretInItem, 'Bravo');
  await content.press('Shift+Tab');
  const facts = await content.evaluate((el) => ({
    emptyUl: [...el.querySelectorAll('ul')].some((u) => u.children.length === 0),
    stylingSpan: !!el.querySelector('span[style*="caret-color"]'),
  }));
  expect(facts.emptyUl).toBe(false);
  expect(facts.stylingSpan).toBe(false);
});

test.fail('toolbar Bullet button (setBulletList) never nests <ul> inside a leftover <p>', async ({ page }) => {
  await openEditor(page, 'First\n\nSecond');
  const content = page.locator('#content');
  await content.evaluate((el) => {
    const ps = el.querySelectorAll('p');
    const r = document.createRange();
    r.setStart(ps[0].firstChild!, 0);
    const last = ps[ps.length - 1].firstChild as Text;
    r.setEnd(last, last.length);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.locator('#fmt-bullet').click();
  const facts = await content.evaluate((el) => ({
    ulInP: !!el.querySelector('p > ul'),
    hasUl: !!el.querySelector('ul'),
  }));
  expect(facts.hasUl).toBe(true);
  expect(facts.ulInP).toBe(false);
});

test.fail(
  'toolbar Numbered button (setNumberedList) on a plain paragraph never nests <ol> inside a leftover <p>',
  async ({ page }) => {
    await openEditor(page, 'Hello world');
    const content = page.locator('#content');
    await content.evaluate((el) => {
      const p = el.querySelector('p')!;
      const r = document.createRange();
      r.selectNodeContents(p);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
    await page.locator('#fmt-numbered').click();
    const facts = await content.evaluate((el) => ({
      hasOl: !!el.querySelector('ol'),
      olInP: !!el.querySelector('p > ol'),
    }));
    expect(facts.hasOl).toBe(true);
    expect(facts.olInP).toBe(false);
  }
);
