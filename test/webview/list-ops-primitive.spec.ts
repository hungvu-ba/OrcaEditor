/**
 * HLR 22 (execCommand List/Block Verb Replacement) Phase 1: real-Chromium test
 * for `commitListOp` (media/webview/list-ops.ts) — the only function in that
 * module touching the live DOM/Selection API. Exercises it via
 * window.ListOpsDebug (see esbuild.js's listOpsDebugConfig + _harness.ts), NOT
 * through any real UI call site — wiring commitListOp into the 14 real sites
 * is Phase 2, out of scope here. The caret-restore callback passed to
 * commitListOp is a small inline reimplementation of dom-utils.ts's
 * placeCaretAtOffsets (character-offset based) rather than an import, so this
 * primitive stays decoupled from the app's #content/focus() coupling.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

test('commitListOp (indent): exactly one execCommand(insertHTML) call, valid li > ul nesting, caret restored precisely inside the moved item', async ({
  page,
}) => {
  await openEditor(page, '- Alpha\n- Bravo');
  const content = page.locator('#content');

  const result = await content.evaluate((el) => {
    const list = el.querySelector('ul')!;
    const bravo = list.children[1] as HTMLLIElement;

    const range = document.createRange();
    range.setStart(bravo.firstChild!, 2);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    interface ListOpPlan {
      stableRoot: Element;
      rangeStart: Element;
      rangeEnd: Element;
      html: string;
      caretAnchor?: Element;
    }
    interface ListOpsDebugApi {
      computeIndent(li: Element): ListOpPlan | null;
      commitListOp(plan: ListOpPlan, placeCaretAtOffsets: (el: Element, start: number, end: number) => void): void;
    }
    const debug = (window as unknown as { ListOpsDebug: ListOpsDebugApi }).ListOpsDebug;
    const plan = debug.computeIndent(bravo);
    if (!plan) {
      return { ok: false as const };
    }

    let insertHtmlCalls = 0;
    const originalExecCommand = document.execCommand.bind(document);
    document.execCommand = ((cmd: string, showUi?: boolean, value?: string) => {
      if (cmd === 'insertHTML') {
        insertHtmlCalls++;
      }
      return originalExecCommand(cmd, showUi, value);
    }) as typeof document.execCommand;

    function locateOffset(root: Element, offset: number): { node: Node; offset: number } {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let remaining = offset;
      let lastText: Text | null = null;
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        lastText = node;
        if (remaining <= node.data.length) {
          return { node, offset: remaining };
        }
        remaining -= node.data.length;
      }
      return lastText ? { node: lastText, offset: lastText.data.length } : { node: root, offset: 0 };
    }
    function placeCaretAtOffsets(root: Element, start: number, end: number): void {
      const startPos = locateOffset(root, start);
      const endPos = locateOffset(root, end);
      const r = document.createRange();
      r.setStart(startPos.node, startPos.offset);
      r.setEnd(endPos.node, endPos.offset);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    }

    debug.commitListOp(plan, placeCaretAtOffsets);
    document.execCommand = originalExecCommand;

    const liInUl = !!el.querySelector('li > ul');
    const ulInUl = !!el.querySelector('ul > ul');
    const anchorMarkerLeaked = !!el.querySelector('[data-list-op-caret-anchor]');

    // Assert the caret precisely (text node + local offset), not via a
    // stableRoot-wide character count: indent removes the whitespace text
    // node markdown-it renders between sibling <li>s (it's now merged into
    // ONE <li>), so a stableRoot-wide "same offset as before" comparison is
    // off by that removed whitespace's length -- not a caret-restore bug,
    // just the wrong invariant to check (HLR 22 Phase 2.1/2.2 review fix: see
    // list-ops.ts's `caretAnchor`/`normalizeToAnchor` for the real fix this
    // test now exercises, for the general case this specific scenario
    // doesn't hit -- the empty-<li>-after-Enter case is covered separately
    // in list-verbs-audit.spec.ts).
    const afterSel = window.getSelection()!;
    const afterRange = afterSel.getRangeAt(0);
    const caretText = afterRange.startContainer.textContent;
    const caretOffset = afterRange.startOffset;

    return { ok: true as const, insertHtmlCalls, liInUl, ulInUl, anchorMarkerLeaked, caretText, caretOffset };
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.insertHtmlCalls).toBe(1);
  expect(result.liInUl).toBe(true);
  expect(result.ulInUl).toBe(false);
  expect(result.anchorMarkerLeaked).toBe(false);
  expect(result.caretText).toBe('Bravo');
  expect(result.caretOffset).toBe(2);
});

// Outdent's plan has rangeStart === rangeEnd (a single parent <li>) but replaces
// it with a MULTI-ROOT html fragment (two sibling <li>s) — a structurally
// different shape from indent's plan (two-element range -> one root).
// execCommand('insertHTML') is CONFIRMED (see commitListOpDirect's doc comment
// in list-ops.ts) to corrupt this exact shape — an earlier version of this test
// drove it through commitListOp and got 51 execCommand calls instead of 1
// (fixOrphanNestedListItems's self-heal loop hitting its 50-iteration safety cap
// trying to repair an orphan <li><ul></ul></li> Chrome left behind). This test
// exercises commitListOpDirect instead, which must produce zero execCommand calls.
test('commitListOpDirect (outdent): zero execCommand calls, later siblings re-nest correctly, caret restored at the same offset', async ({
  page,
}) => {
  await openEditor(page, '- A\n  - B\n  - C');
  const content = page.locator('#content');

  const result = await content.evaluate((el) => {
    const outerList = el.querySelector('ul')!;
    const aLi = outerList.children[0] as HTMLLIElement;
    const innerList = Array.from(aLi.children).find((c) => c.tagName === 'UL') as HTMLElement;
    const bLi = innerList.children[0] as HTMLLIElement;

    const range = document.createRange();
    range.setStart(bLi.firstChild!, 1);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const beforeProbe = document.createRange();
    beforeProbe.selectNodeContents(outerList);
    beforeProbe.setEnd(range.startContainer, range.startOffset);
    const expectedOffset = beforeProbe.toString().length;

    interface ListOpPlan {
      stableRoot: Element;
      rangeStart: Element;
      rangeEnd: Element;
      html: string;
    }
    interface ListOpsDebugApi {
      computeOutdent(li: Element): ListOpPlan | null;
      commitListOpDirect(
        plan: ListOpPlan,
        placeCaretAtOffsets: (el: Element, start: number, end: number) => void
      ): void;
    }
    const debug = (window as unknown as { ListOpsDebug: ListOpsDebugApi }).ListOpsDebug;
    const plan = debug.computeOutdent(bLi);
    if (!plan) {
      return { ok: false as const };
    }

    let insertHtmlCalls = 0;
    const originalExecCommand = document.execCommand.bind(document);
    document.execCommand = ((cmd: string, showUi?: boolean, value?: string) => {
      if (cmd === 'insertHTML') {
        insertHtmlCalls++;
      }
      return originalExecCommand(cmd, showUi, value);
    }) as typeof document.execCommand;

    function locateOffset(root: Element, offset: number): { node: Node; offset: number } {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let remaining = offset;
      let lastText: Text | null = null;
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        lastText = node;
        if (remaining <= node.data.length) {
          return { node, offset: remaining };
        }
        remaining -= node.data.length;
      }
      return lastText ? { node: lastText, offset: lastText.data.length } : { node: root, offset: 0 };
    }
    function placeCaretAtOffsets(root: Element, start: number, end: number): void {
      const startPos = locateOffset(root, start);
      const endPos = locateOffset(root, end);
      const r = document.createRange();
      r.setStart(startPos.node, startPos.offset);
      r.setEnd(endPos.node, endPos.offset);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    }

    debug.commitListOpDirect(plan, placeCaretAtOffsets);
    document.execCommand = originalExecCommand;

    // Expect: outerList now has 2 top-level <li>s (A, B), B contains a nested
    // <ul> with C — no li>li, no orphan empty <ul>.
    const topLevelLis = Array.from(outerList.children).filter((c) => c.tagName === 'LI');
    const liInLi = !!el.querySelector('li > li');
    const emptyUl = [...el.querySelectorAll('ul')].some((u) => u.children.length === 0);

    const afterSel = window.getSelection()!;
    const afterRange = afterSel.getRangeAt(0);
    const probe = document.createRange();
    probe.selectNodeContents(outerList);
    probe.setEnd(afterRange.startContainer, afterRange.startOffset);
    const caretOffset = probe.toString().length;

    return {
      ok: true as const,
      insertHtmlCalls,
      topLevelLiCount: topLevelLis.length,
      liInLi,
      emptyUl,
      expectedOffset,
      caretOffset,
    };
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.insertHtmlCalls).toBe(0);
  expect(result.topLevelLiCount).toBe(2);
  expect(result.liInLi).toBe(false);
  expect(result.emptyUl).toBe(false);
  expect(result.caretOffset).toBe(result.expectedOffset);
});

test('commitListOp (toList): exactly one execCommand(insertHTML) call, tight <ul> (no <p> wrapper), caret restored at the same offset', async ({
  page,
}) => {
  await openEditor(page, 'First\n\nSecond');
  const content = page.locator('#content');

  const result = await content.evaluate((el) => {
    const ps = Array.from(el.querySelectorAll('p'));

    const range = document.createRange();
    range.setStart(ps[1].firstChild!, 2);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const beforeProbe = document.createRange();
    beforeProbe.selectNodeContents(el);
    beforeProbe.setEnd(range.startContainer, range.startOffset);
    const expectedOffset = beforeProbe.toString().length;

    interface ListOpPlan {
      stableRoot: Element;
      rangeStart: Element;
      rangeEnd: Element;
      html: string;
    }
    interface ListOpsDebugApi {
      computeToList(blocks: Element[], ordered: boolean): ListOpPlan;
      commitListOp(plan: ListOpPlan, placeCaretAtOffsets: (el: Element, start: number, end: number) => void): void;
    }
    const debug = (window as unknown as { ListOpsDebug: ListOpsDebugApi }).ListOpsDebug;
    const plan = debug.computeToList(ps, false);

    let insertHtmlCalls = 0;
    const originalExecCommand = document.execCommand.bind(document);
    document.execCommand = ((cmd: string, showUi?: boolean, value?: string) => {
      if (cmd === 'insertHTML') {
        insertHtmlCalls++;
      }
      return originalExecCommand(cmd, showUi, value);
    }) as typeof document.execCommand;

    function locateOffset(root: Element, offset: number): { node: Node; offset: number } {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let remaining = offset;
      let lastText: Text | null = null;
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        lastText = node;
        if (remaining <= node.data.length) {
          return { node, offset: remaining };
        }
        remaining -= node.data.length;
      }
      return lastText ? { node: lastText, offset: lastText.data.length } : { node: root, offset: 0 };
    }
    function placeCaretAtOffsets(root: Element, start: number, end: number): void {
      const startPos = locateOffset(root, start);
      const endPos = locateOffset(root, end);
      const r = document.createRange();
      r.setStart(startPos.node, startPos.offset);
      r.setEnd(endPos.node, endPos.offset);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    }

    debug.commitListOp(plan, placeCaretAtOffsets);
    document.execCommand = originalExecCommand;

    const ulInP = !!el.querySelector('p > ul');
    const hasUl = !!el.querySelector('ul');

    const afterSel = window.getSelection()!;
    const afterRange = afterSel.getRangeAt(0);
    const probe = document.createRange();
    probe.selectNodeContents(el);
    probe.setEnd(afterRange.startContainer, afterRange.startOffset);
    const caretOffset = probe.toString().length;

    return { insertHtmlCalls, ulInP, hasUl, expectedOffset, caretOffset };
  });

  expect(result.insertHtmlCalls).toBe(1);
  expect(result.ulInP).toBe(false);
  expect(result.hasUl).toBe(true);
  expect(result.caretOffset).toBe(result.expectedOffset);
});
