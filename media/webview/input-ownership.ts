/**
 * Editor keyboard-input ownership flag (Req 20 US-20.2).
 *
 * When a trigger overlay (e.g. the @/slash popup) is open it needs to own the
 * editor keyboard so navigation keys drive the popup instead of the document.
 * Input-driven editor handlers (input-rules, main's content keydown) check
 * hasInputOwner() first and bail while an overlay owns input.
 *
 * KEPT after the focused-input refactor (evaluated for removal, T2.2). In the
 * current model the popup's own <input> holds focus while open, so most keystrokes
 * fire on the input (not #content) and never reach the two #content keydown
 * bail-sites — but this flag is NOT dead: it is the tested contract (see
 * trigger-popup-shell.spec.ts "input-ownership: editor input rule is suppressed
 * while the shell is open") and the defense-in-depth guarantee that editor
 * input-rules / shortcuts stand down for ANY keystroke that still reaches #content
 * while a popup owns input (e.g. a shell-driven session that never moved focus, or
 * a focus-timing edge at open). Cheap, correct, and load-bearing for that contract.
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
const RELEASE_KEY = '__mdInputOwnerRelease';
interface OwnerHost {
  [OWNER_KEY]?: string | null;
  [RELEASE_KEY]?: Array<() => void>;
}
const host = globalThis as unknown as OwnerHost;

/** Claim the editor keyboard for an overlay (e.g. 'trigger'); pass null to release. */
export function setInputOwner(next: string | null): void {
  const wasOwned = (host[OWNER_KEY] ?? null) !== null;
  host[OWNER_KEY] = next;
  // On owner→null (overlay closed), fire release listeners. Bug #3: main.ts uses
  // this to flush a host document 'update' it deferred while the popup was open
  // (rendering under an open popup detaches its Range and steals input focus).
  if (wasOwned && next === null) {
    for (const cb of host[RELEASE_KEY] ?? []) {
      cb();
    }
  }
}

/** True while an overlay owns keyboard input — input-driven editor handlers must bail first. */
export function hasInputOwner(): boolean {
  return (host[OWNER_KEY] ?? null) !== null;
}

/**
 * Register a callback fired each time input ownership is released (owner→null).
 * Listeners live on the same global slot as the owner flag so a registration in
 * one bundle still fires for a release in another (see the OWNER_KEY note).
 */
export function onInputOwnerRelease(cb: () => void): void {
  (host[RELEASE_KEY] ??= []).push(cb);
}
