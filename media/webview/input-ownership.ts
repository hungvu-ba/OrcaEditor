/**
 * Editor keyboard-input ownership flag (Req 20 US-20.2).
 *
 * When a trigger overlay (e.g. the @/slash popup) is open it needs to own the
 * editor keyboard so navigation keys drive the popup instead of the document.
 * Input-driven editor handlers (input-rules, main's content keydown) check
 * hasInputOwner() first and bail while an overlay owns input.
 *
 * Deliberately a leaf module: NO imports of any webview module, so it can be
 * imported anywhere without risking a cycle (e.g. through main.ts).
 */

// State lives on a single global slot, not a module-local variable, so that when
// the overlay code and the editor's input handlers end up in SEPARATE bundles
// (e.g. the test-only trigger-popup-debug.js vs. the real main.js — each carries
// its own copy of this module), a setInputOwner() from one is still observed by
// hasInputOwner() in the other. One flag, one editor, one owner.
const OWNER_KEY = '__mdInputOwner';
interface OwnerHost {
  [OWNER_KEY]?: string | null;
}
const host = globalThis as unknown as OwnerHost;

/** Claim the editor keyboard for an overlay (e.g. 'trigger'); pass null to release. */
export function setInputOwner(next: string | null): void {
  host[OWNER_KEY] = next;
}

/** True while an overlay owns keyboard input — input-driven editor handlers must bail first. */
export function hasInputOwner(): boolean {
  return (host[OWNER_KEY] ?? null) !== null;
}
