/**
 * Shared right-dock tab container (Req 23 US-23.7).
 *
 * Turns a docked-right `<aside>` into a tabbed container: a 32px tab strip owns
 * the panel's top edge, each registered tab contributes one body element, and
 * exactly one body is visible at a time. The strip is a single tab stop
 * (`role="tablist"` + roving tabindex) and carries a `⋯` overflow button whose
 * menu contents are contributed by the ACTIVE tab — the button is not rendered
 * at all while that tab has registered no items, so no empty menu can be opened.
 *
 * The dock owns only the strip, the menu and tab visibility. Opening/closing the
 * panel itself stays with the caller (toc.ts's `toc-open` body class), and so
 * does the dock-level Escape handler (main.ts, where the close can pair with
 * syncTocButton()) — the caller is what knows whether the panel is open. A caller
 * that closes the panel MUST call `closeMenu()`: the menu is not a child of the
 * panel and will not disappear with it.
 *
 * The menu owns its own keyboard model (added with US-10.8, the first tab to
 * register items): opening moves focus to the checked row, ↑/↓/Home/End traverse,
 * and closing hands focus back to the `⋯` button — which also keeps the panel
 * Escape-closable, since main.ts's dock handler requires focus inside the panel.
 *
 * Deferred to US-23.9, where a second tab makes each observable (see
 * `_bmad-output/quick-dev/deferred-work.md`): ←/→ traversal across headers, and
 * the visible half of tab switching / last-tab restore.
 */

import {
  RIGHT_DOCK_MENU_BTN_CLASS,
  RIGHT_DOCK_MENU_CLASS,
  RIGHT_DOCK_MENU_ITEM_CLASS,
  RIGHT_DOCK_STRIP_CLASS,
  RIGHT_DOCK_TABLIST_CLASS,
  RIGHT_DOCK_TABPANEL_CLASS,
  RIGHT_DOCK_TAB_CLASS,
} from './constants';
import { ESCAPE_PRIORITY, initPopoverDismiss } from './escape-stack';
import type { VsCodeApi } from './vscode-api';

/** One row in a tab's `⋯` overflow menu. */
export interface RightDockMenuItem {
  label: string;
  /** Renders the check column filled. Omit for a plain command row. */
  checked?: boolean;
  onSelect(): void;
}

export interface RightDockTab {
  id: string;
  /** Strip label — rendered uppercase by CSS, so pass it in natural case. */
  label: string;
  /** The tab's content, appended to the panel and shown only while active. */
  body: HTMLElement;
  /** Section title above this tab's rows in the `⋯` menu. */
  menuTitle?: string;
  /** Whether the menu rows are one-of-N or independent toggles. Drives ARIA only. */
  menuSelection?: 'single' | 'multiple';
  /**
   * Read fresh on every menu open so check state is live. Omitted — or returning
   * an empty array — hides the `⋯` button while this tab is active.
   */
  menuItems?(): RightDockMenuItem[];
}

export interface TabDock {
  /** Add a tab. The first registered tab, or the one matching the restored id, becomes active. */
  registerTab(tab: RightDockTab): void;
  /** Show `id`'s body and hide the rest. No-op for an unknown id. */
  activate(id: string): void;
  activeId(): string | undefined;
  /** Dismiss the `⋯` menu. The caller must call this whenever it closes the panel. */
  closeMenu(): void;
}

/**
 * Handoff geometry: the menu hangs 34px below the tab strip's top edge, 8px in
 * from the panel's right. Measured off the STRIP, not the panel — the panel's own
 * top edge sits behind the sticky toolbar band, so a panel-relative offset would
 * put the menu above the strip and under #toolbar.
 */
const MENU_OFFSET_TOP_PX = 34;
const MENU_OFFSET_RIGHT_PX = 8;

/** Disambiguates ARIA ids when more than one dock exists (tests build their own). */
let dockSeq = 0;

export function createTabDock(panel: HTMLElement, vscode?: VsCodeApi): TabDock {
  const uid = `right-dock-${++dockSeq}`;
  const tabs: RightDockTab[] = [];
  const headers = new Map<string, HTMLButtonElement>();
  const restoredTabId = vscode?.getState()?.rightDockTab;
  let activeTabId: string | undefined;

  const strip = document.createElement('div');
  strip.className = RIGHT_DOCK_STRIP_CLASS;

  // The tablist is an inner element, not the strip itself: a `tablist` may only
  // own `tab` children, so the `⋯` button has to be its sibling rather than a
  // foreign child that assistive tech would either drop or miscount.
  const tablist = document.createElement('div');
  tablist.className = RIGHT_DOCK_TABLIST_CLASS;
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Panel tabs');
  strip.appendChild(tablist);

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = RIGHT_DOCK_MENU_BTN_CLASS;
  menuBtn.textContent = '⋯';
  menuBtn.setAttribute('aria-haspopup', 'menu');
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.setAttribute('aria-label', 'More panel options');
  panel.appendChild(strip);

  // Rendered as a document.body child rather than inside the panel: #toc-panel is
  // overflow:hidden (it has to clip its contents while collapsing to width 0), so
  // a menu parented there would be cut off. Positioning against the panel's box
  // keeps it anchored to the panel as the design requires, while leaving the
  // shipped panel geometry — overflow, the width transition, the close animation —
  // untouched. The cost is that closing the panel does NOT take the menu with it:
  // the panel stays hit-testable for its whole 300ms collapse, and several close
  // paths involve no mousedown at all, so the caller owes us closeMenu().
  const menu = document.createElement('div');
  menu.className = RIGHT_DOCK_MENU_CLASS;
  menu.id = `${uid}-menu`;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Panel options');
  menu.hidden = true;
  document.body.appendChild(menu);
  menuBtn.setAttribute('aria-controls', menu.id);

  const menuDismiss = initPopoverDismiss(
    menu,
    () => {
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.classList.remove('open');
      // Hiding the menu would drop focus to <body> whenever a row held it, and
      // the dock-level Escape handler (main.ts) bails unless focus is inside the
      // panel — so a keyboard user who opened the menu could no longer Escape the
      // panel. The button lives in the strip, i.e. inside the panel, so handing
      // focus back there restores both that path and the expected menu-button
      // return. Guarded: only reclaim focus we actually owned, or closing the
      // menu from a click elsewhere would steal focus from the click target.
      if (menu.contains(document.activeElement)) {
        menuBtn.focus();
      }
    },
    ESCAPE_PRIORITY.DOCK_MENU
  );

  /** Focusable menu rows, in DOM order. Rebuilt per open, so never cached. */
  function menuRows(): HTMLButtonElement[] {
    return Array.from(menu.querySelectorAll<HTMLButtonElement>(`.${RIGHT_DOCK_MENU_ITEM_CLASS}`));
  }

  /**
   * `role="menu"` implies ↑/↓/Home/End, and without it the rows are reachable
   * only by tabbing past every element between the menu (a document.body child,
   * appended last) and the button — for the TOC that means the whole outline. So
   * the menu owns arrow traversal itself and moves focus in on open.
   */
  function focusRow(index: number): void {
    const rows = menuRows();
    if (rows.length === 0) {
      return;
    }
    // Wrap both ways: a menu is a closed ring, unlike a tablist's roving tabindex.
    const wrapped = ((index % rows.length) + rows.length) % rows.length;
    rows[wrapped].focus();
  }

  menu.addEventListener('keydown', (e) => {
    const rows = menuRows();
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    switch (e.key) {
      case 'ArrowDown':
        focusRow(current + 1);
        break;
      case 'ArrowUp':
        // -1 (nothing focused yet) + -1 = -2 → wraps to the last row, which is
        // what ArrowUp on a freshly-opened menu should do.
        focusRow(current - 1);
        break;
      case 'Home':
        focusRow(0);
        break;
      case 'End':
        focusRow(rows.length - 1);
        break;
      default:
        return;
    }
    // Only after a handled key: an unhandled one must stay available to the
    // escape stack, and the arrows must not scroll the document behind the menu.
    e.preventDefault();
    e.stopPropagation();
  });

  function activeTab(): RightDockTab | undefined {
    return tabs.find((t) => t.id === activeTabId);
  }

  function itemsForActiveTab(): RightDockMenuItem[] {
    return activeTab()?.menuItems?.() ?? [];
  }

  /** AC5: the button is not RENDERED while the active tab has no items — not merely
   *  hidden, so there is nothing in the DOM for a stylesheet or a test to resurrect. */
  function updateMenuButton(): void {
    const wanted = itemsForActiveTab().length > 0;
    if (wanted && menuBtn.parentNode === null) {
      strip.appendChild(menuBtn);
    } else if (!wanted && menuBtn.parentNode !== null) {
      menuDismiss.close();
      menuBtn.remove();
    }
  }

  function buildMenu(tab: RightDockTab, items: RightDockMenuItem[]): void {
    menu.textContent = '';
    if (tab.menuTitle !== undefined) {
      const title = document.createElement('div');
      title.className = 'right-dock-menu-title';
      // role=menu may only own menuitem*/group/separator — a bare div would be
      // announced unpredictably, so mark the section title as decoration.
      title.setAttribute('role', 'presentation');
      title.textContent = tab.menuTitle;
      menu.appendChild(title);
    }
    const role = tab.menuSelection === 'multiple' ? 'menuitemcheckbox' : 'menuitemradio';
    for (const item of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = RIGHT_DOCK_MENU_ITEM_CLASS;
      if (item.checked === undefined) {
        row.setAttribute('role', 'menuitem');
      } else {
        row.setAttribute('role', role);
        row.setAttribute('aria-checked', String(item.checked));
      }
      const check = document.createElement('span');
      check.className = 'right-dock-menu-check';
      check.textContent = item.checked === true ? '✓' : '';
      row.appendChild(check);
      const label = document.createElement('span');
      label.className = 'right-dock-menu-label';
      label.textContent = item.label;
      row.appendChild(label);
      row.addEventListener('click', () => {
        menuDismiss.close();
        item.onSelect();
      });
      menu.appendChild(row);
    }
  }

  function openMenu(): void {
    const tab = activeTab();
    const items = itemsForActiveTab();
    if (tab === undefined || items.length === 0) {
      return;
    }
    buildMenu(tab, items);
    const stripRect = strip.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    menu.style.top = `${stripRect.top + MENU_OFFSET_TOP_PX}px`;
    // documentElement.clientWidth, not window.innerWidth: `right` on a fixed
    // element resolves against the initial containing block, which EXCLUDES a
    // classic scrollbar while innerWidth includes it — the difference is 0 on
    // macOS overlay scrollbars and ~15px on Windows (CLAUDE.md cross-platform trap).
    menu.style.right = `${document.documentElement.clientWidth - panelRect.right + MENU_OFFSET_RIGHT_PX}px`;
    menu.hidden = false;
    menuDismiss.arm();
    menuBtn.setAttribute('aria-expanded', 'true');
    menuBtn.classList.add('open');
    // Focus lands on the checked row (a single-select menu opens "at" its current
    // value) or the first row otherwise — mouse users are unaffected, since the
    // rows carry no visible focus-only styling beyond :focus-visible.
    const checkedAt = items.findIndex((item) => item.checked === true);
    focusRow(checkedAt >= 0 ? checkedAt : 0);
  }

  // The menu is fixed-positioned against a rect measured once at open time, and
  // nothing else re-measures it: a resize moves the right-docked panel out from
  // under it. Closing is the honest response — repositioning would also have to
  // chase the panel's own width transition.
  window.addEventListener('resize', () => menuDismiss.close());

  // The button sits OUTSIDE the menu (the menu is a document.body child), so
  // initPopoverDismiss's document-level outside-mousedown handler already closed
  // the menu by the time `click` runs — testing `isOpen` there would always read
  // false and re-open, making the button unable to ever close its own menu. Latch
  // the state on the button's own mousedown, which fires first because bubbling
  // starts at the target.
  let openBeforePress = false;
  menuBtn.addEventListener('mousedown', () => {
    openBeforePress = menuDismiss.isOpen;
  });
  menuBtn.addEventListener('click', () => {
    if (!openBeforePress) {
      openMenu();
    }
    openBeforePress = false;
  });

  function activate(id: string, persist = true): void {
    if (!headers.has(id)) {
      return;
    }
    menuDismiss.close();
    activeTabId = id;
    for (const tab of tabs) {
      const selected = tab.id === id;
      const header = headers.get(tab.id);
      if (header !== undefined) {
        header.setAttribute('aria-selected', String(selected));
        header.tabIndex = selected ? 0 : -1;
        header.classList.toggle('active', selected);
      }
      tab.body.hidden = !selected;
    }
    updateMenuButton();
    if (persist) {
      // Same scope and merge discipline as tocWidth/tocMaxLevel (US-23.7 AC7).
      vscode?.setState({ ...vscode.getState(), rightDockTab: id });
    }
  }

  function registerTab(tab: RightDockTab): void {
    if (headers.has(tab.id)) {
      return;
    }
    tabs.push(tab);

    const header = document.createElement('button');
    header.type = 'button';
    header.className = RIGHT_DOCK_TAB_CLASS;
    header.id = `${uid}-tab-${tab.id}`;
    header.textContent = tab.label;
    header.setAttribute('role', 'tab');
    header.setAttribute('aria-selected', 'false');
    header.tabIndex = -1;
    header.addEventListener('click', () => activate(tab.id));

    if (tab.body.id === '') {
      tab.body.id = `${uid}-panel-${tab.id}`;
    }
    header.setAttribute('aria-controls', tab.body.id);
    tab.body.setAttribute('role', 'tabpanel');
    tab.body.setAttribute('aria-labelledby', header.id);
    // The class is what makes `hidden` stick: an author `display` on the body —
    // #toc-tabpanel needs `display: flex` — outranks the UA's [hidden] rule
    // regardless of specificity, so the dock ships its own [hidden] override.
    tab.body.classList.add(RIGHT_DOCK_TABPANEL_CLASS);
    tab.body.hidden = true;

    headers.set(tab.id, header);
    tablist.appendChild(header);
    panel.appendChild(tab.body);

    // A fresh dock lands on its first tab; a restored id wins as soon as the tab
    // it names registers, which is how the last-selected tab comes back. Neither
    // is a user choice, so neither overwrites the persisted id — otherwise a
    // restored tab that registers late would have its own record destroyed first.
    if (activeTabId === undefined || tab.id === restoredTabId) {
      activate(tab.id, false);
    }
  }

  return {
    registerTab,
    activate,
    activeId: () => activeTabId,
    closeMenu: () => menuDismiss.close(),
  };
}
