/**
 * Shared lazy-loader for the standalone diagram-engine bundles
 * (dist/webview/plantuml-engine.js, dist/webview/mermaid-engine.js): both
 * inject a nonce'd <script> that publishes a global on `window`, and both
 * need the exact same single-flight-promise + failure-cleanup behavior — see
 * P-1 (Performance — Audit.md) and US-2.8.
 */

export interface EngineConfig {
  engineUri: string;
  scriptNonce: string;
}

export interface EngineLoadMessages {
  /** Error thrown when no `EngineConfig` was ever provided by the host. */
  notConfigured: string;
  /** Error thrown when the script loaded but never published `window[globalKey]`. */
  loadedButEmpty: string;
  /** Error thrown when the `<script>` itself fails to load (network/404). */
  failed: string;
}

/**
 * Injects a nonce'd `<script src="config.engineUri">` and resolves with
 * `window[globalKey]` once it loads (or immediately, if some earlier call
 * already published it). Removes the `<script>` element again on every
 * failure path (missing config, load error, or loaded-but-empty global) so a
 * caller's retry-on-failure never accumulates orphaned tags in `<head>`.
 */
export function loadNoncedEngineScript<T>(
  globalKey: string,
  config: EngineConfig | undefined,
  messages: EngineLoadMessages
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const globals = window as unknown as Record<string, T | undefined>;
    if (!config) {
      reject(new Error(messages.notConfigured));
      return;
    }
    const existing = globals[globalKey];
    if (existing) {
      resolve(existing);
      return;
    }
    const script = document.createElement('script');
    script.src = config.engineUri;
    // CSP: script-src only accepts scripts carrying the page's nonce.
    script.nonce = config.scriptNonce;
    script.addEventListener('load', () => {
      const engine = globals[globalKey];
      if (engine) {
        resolve(engine);
      } else {
        script.remove();
        reject(new Error(messages.loadedButEmpty));
      }
    });
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error(messages.failed));
    });
    document.head.appendChild(script);
  });
}
