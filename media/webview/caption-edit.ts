/**
 * bug_General Mention Declare #6: click-to-edit popover for a declaration pill
 * (`.md-caption` badge). The pill is a non-editable atom (contenteditable=false,
 * set by postProcessCaptions), so this popover is the only edit path. It edits
 * the VALUE (id) only — the namespace stays fixed (PO decision). On confirm it
 * validates the new value against the namespace's already-declared entities
 * (same case-sensitive id match the `/declare` id step uses) and refuses a
 * duplicate / empty / whitespace / namespace-shifting value with an inline
 * error. Mirrors quick-correct.ts's anchored-popover + escape-stack shell
 * (deliberately its own module, not shared — same per-module-duplication
 * precedent the trigger flow follows).
 */
import { el, positionNear } from './dom-utils';
import { initPopoverDismiss } from './escape-stack';
import { fillCaptionBadge } from './dom-postprocess';
import type { VsCodeApi } from './vscode-api';
import type { EntitySuggestion } from '../../src/shared/messages';

/** Leading Unicode-letter run = namespace (mirrors entity-index.ts / dom-postprocess). */
const NAMESPACE_RE = /^\p{L}+/u;
const CAPTION_PREFIX = 'caption::';

export interface CaptionEditController {
  /** Open the value-edit popover for a `.md-caption` declaration badge. */
  open(badge: HTMLElement): void;
  /** Message-handler hook: forward an `entityResult` reply here (own requestId sequence — ignored if stale). */
  notifyEntityResult(requestId: number, ready: boolean, entities: EntitySuggestion[]): void;
}

/** Parse a `.md-caption` badge's `caption::NS_ID` text into {namespace, id} — null if malformed. */
function parseBadge(badge: Element): { namespace: string; id: string } | null {
  const text = (badge.textContent ?? '').trim();
  if (!text.startsWith(CAPTION_PREFIX)) {
    return null;
  }
  const token = text.slice(CAPTION_PREFIX.length);
  const m = NAMESPACE_RE.exec(token);
  if (!m || m[0].length >= token.length) {
    return null; // no namespace letters, or empty id half.
  }
  return { namespace: m[0], id: token.slice(m[0].length) };
}

export function initCaptionEdit(vscode: VsCodeApi, onEdited: () => void): CaptionEditController {
  const popover = el('div', 'caption-edit-popover');
  popover.hidden = true;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'caption-edit-input';
  popover.appendChild(input);

  const errorEl = el('div', 'caption-edit-error');
  errorEl.hidden = true;
  popover.appendChild(errorEl);

  const confirmBtn = el('button', 'caption-edit-confirm', 'Save');
  confirmBtn.type = 'button';
  popover.appendChild(confirmBtn);

  document.body.appendChild(popover);

  let currentBadge: HTMLElement | undefined;
  let currentNamespace = '';
  let currentId = '';
  /** Ids already declared in `currentNamespace` (from the entity index) — case-sensitive, mirrors the /declare dup rule. */
  let namespaceIds = new Set<string>();
  let reqSeq = 0;
  const dismiss = initPopoverDismiss(popover, () => {
    currentBadge = undefined;
  });

  /** Validate the typed value against the fixed namespace; return an error string or null. */
  function validate(value: string): string | null {
    const v = value.trim();
    if (!v) {
      return 'Value can’t be empty';
    }
    if (/\s/.test(v)) {
      return 'Value can’t contain spaces';
    }
    // A value starting with a letter would fold into the namespace under the
    // leading-letter-run rule — but the namespace is fixed here, so refuse it.
    if (NAMESPACE_RE.test(v)) {
      return 'Value can’t start with a letter';
    }
    if (v !== currentId && namespaceIds.has(v)) {
      return `${currentNamespace}${v} is already declared`;
    }
    return null;
  }

  function refreshValidity(): void {
    const msg = validate(input.value);
    if (msg) {
      errorEl.textContent = msg;
      errorEl.hidden = false;
      confirmBtn.disabled = true;
    } else {
      errorEl.hidden = true;
      confirmBtn.disabled = false;
    }
  }

  function commit(): void {
    const badge = currentBadge;
    if (!badge) {
      return;
    }
    const v = input.value.trim();
    if (validate(v)) {
      return; // guarded — the button is disabled, but never commit an invalid value.
    }
    // Rewrite the badge in place; textContent becomes `caption::NS_v` so the
    // next serialize/round-trip writes the new declaration verbatim.
    fillCaptionBadge(badge, `${currentNamespace}${v}`, document);
    dismiss.close();
    onEdited();
  }

  input.addEventListener('input', refreshValidity);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!confirmBtn.disabled) {
        commit();
      }
    }
  });
  confirmBtn.addEventListener('mousedown', (e) => e.preventDefault());
  confirmBtn.addEventListener('click', () => {
    if (!confirmBtn.disabled) {
      commit();
    }
  });

  function open(badge: HTMLElement): void {
    // Validate the click target BEFORE dismissing any open popover — a corrupted
    // badge (text not starting with `caption::`) must be a no-op, not close a
    // popover the user is mid-edit in.
    const parsed = parseBadge(badge);
    if (!parsed) {
      return;
    }
    if (dismiss.isOpen) {
      dismiss.close();
    }
    currentBadge = badge;
    currentNamespace = parsed.namespace;
    currentId = parsed.id;
    namespaceIds = new Set();
    popover.hidden = false;
    positionNear(popover, badge.getBoundingClientRect());
    input.value = currentId;
    errorEl.hidden = true;
    confirmBtn.disabled = false;
    dismiss.arm();
    input.focus();
    input.select();
    // Fetch the namespace's declared ids for the duplicate check (reuses the
    // same host message the /declare id step uses — no new round-trip shape).
    vscode.postMessage({ type: 'entitySearch', query: '', namespace: currentNamespace, requestId: ++reqSeq });
  }

  return {
    open,
    notifyEntityResult(requestId, ready, entities): void {
      if (requestId !== reqSeq || popover.hidden) {
        return; // stale/superseded, or the popover already closed.
      }
      if (!ready) {
        return; // index still building — keep confirm enabled, best-effort dup check.
      }
      namespaceIds = new Set(entities.filter((e) => e.namespace === currentNamespace).map((e) => e.id));
      refreshValidity();
    },
  };
}
