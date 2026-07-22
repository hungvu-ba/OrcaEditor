/**
 * Shared capture-phase Escape arbiter (Req 20 US-20.4).
 *
 * Multiple features (drag-cancel, trigger/@ popup, cross-file search, Zen) all
 * want to react to the Escape key. Without coordination they each attach their
 * own document keydown listener and a single Escape can fire several of them at
 * once. This module gives them ONE capture-phase document listener: per keypress
 * only the highest-priority ACTIVE handler runs, then the key is consumed.
 *
 * A handler reports its own activeness by its boolean return: `true` means "I was
 * active and I consumed this Escape" (arbitration stops, the event is
 * preventDefault/stopPropagation'd); `false` means "I was not active" (the next
 * lower-priority handler is tried). If no handler returns true the key falls
 * through untouched, preserving any non-migrated bubble-phase Escape listeners.
 */

/** Priority tiers — higher wins. */
export const ESCAPE_PRIORITY = {
  DRAG: 30,
  POPUP: 20,
  CROSS_FILE: 15,
  ZEN: 10,
} as const;

export interface Disposable {
  dispose(): void;
}

interface Entry {
  priority: number;
  handler: () => boolean;
}

const entries: Entry[] = [];
let listenerInstalled = false;

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  // Priority-descending snapshot (registration order breaks ties; same-priority
  // handlers here are mutually exclusive so tie order is irrelevant).
  const ordered = entries.slice().sort((a, b) => b.priority - a.priority);
  for (const entry of ordered) {
    if (entry.handler()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }
}

function ensureListener(): void {
  if (listenerInstalled) return;
  document.addEventListener('keydown', onKeyDown, true);
  listenerInstalled = true;
}

/**
 * Register a capture-phase Escape handler at the given priority. The handler must
 * return whether it was active AND consumed the key. Returns a Disposable that
 * removes the registration.
 */
export function registerEscapeHandler(priority: number, handler: () => boolean): Disposable {
  const entry: Entry = { priority, handler };
  entries.push(entry);
  ensureListener();
  return {
    dispose(): void {
      const i = entries.indexOf(entry);
      if (i >= 0) entries.splice(i, 1);
    },
  };
}

/** Shared dismissal lifecycle for an anchored popover (see initPopoverDismiss). */
export interface PopoverDismiss {
  /** True while the popover is showing. */
  readonly isOpen: boolean;
  /** (Re)arm the POPUP-priority Escape handler — call inside the popover's open(). */
  arm(): void;
  /** Hide the popover, dispose the Escape handler, then run the per-module cleanup. No-op if already hidden. */
  close(): void;
}

/**
 * Own the full dismissal lifecycle shared by the anchored popovers
 * (quick-correct.ts, caption-edit.ts): the `popover.hidden` toggle, a
 * POPUP-priority Escape handler, and an outside-`mousedown` close (listener
 * attached once, here). Each consumer supplies only its own per-close cleanup
 * via `onClose` — so the identical hide/guard/dispose boilerplate lives in ONE
 * place instead of being copied per popover.
 */
export function initPopoverDismiss(popover: HTMLElement, onClose: () => void): PopoverDismiss {
  let escDisposable: Disposable | undefined;
  const api: PopoverDismiss = {
    get isOpen(): boolean {
      return !popover.hidden;
    },
    arm(): void {
      escDisposable?.dispose();
      escDisposable = registerEscapeHandler(ESCAPE_PRIORITY.POPUP, () => {
        if (popover.hidden) {
          return false;
        }
        api.close();
        return true;
      });
    },
    close(): void {
      if (popover.hidden) {
        return;
      }
      popover.hidden = true;
      escDisposable?.dispose();
      escDisposable = undefined;
      onClose();
    },
  };
  document.addEventListener('mousedown', (e) => {
    if (popover.hidden) {
      return;
    }
    if (!popover.contains(e.target as Node)) {
      api.close();
    }
  });
  return api;
}
