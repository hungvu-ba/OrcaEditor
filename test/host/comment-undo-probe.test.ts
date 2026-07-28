/**
 * Req 24 US-23.18 — the two probes the story's Sizing note requires before any
 * gate is built, written as regression locks.
 *
 * The story's discipline (its own PO decision on AC6): "reproduce before
 * building anything… If it is not reachable, AC6 is met by a regression test
 * that locks that behaviour in — no gate is built. If it *is* reachable, that's
 * a confirmed bug at that point, and the fix is scoped and built then, against
 * the actual failure mode observed — not designed speculatively now."
 *
 * So these two cases are deliberately written to PASS against current behaviour
 * and to fail only if it regresses. A failure here on first run is not a broken
 * test — it is the probe reporting a confirmed defect, and the story says to
 * scope that fix as its own follow-up pass rather than pre-designing one now.
 *
 * **Not run by this story's authoring agent.** `@vscode/test-electron` launches
 * a real Electron subprocess, which a sandboxed agent shell cannot do — the same
 * limitation US-23.17's own implementation note records ("Verified green
 * end-to-end by the human running `npm run test:host` locally"). The Sizing note
 * also asks for the probe on **Windows** as well as macOS (CLAUDE.md's
 * cross-platform rule); that run is likewise outside this agent's environment
 * and is the human's to perform.
 *
 * ## What AC1's probe here does and does not cover — read before trusting it
 *
 * AC1 wants the keystroke proven harmless **on the document**. Half of that is
 * reachable and half is not, and the split is a property of the public API, not
 * an omission:
 *
 *  - **Covered here:** the document-level baseline — `document.version`,
 *    `onDidChangeTextDocument` and the text itself, measured around a real
 *    `undo` command. This is the measurement AC1 names.
 *  - **Covered in `test/webview/comment-undo-safety.spec.ts`:** that the guard
 *    actually consumes the chord, asserted on `defaultPrevented` — the guard's
 *    own observable effect, which fails if `initCommentUndoGuard()` is removed.
 *  - **Not covered anywhere, and not coverable:** dispatching a real keystroke
 *    *into the rendered webview* and following it through VS Code's keybinding
 *    layer to the document. The host API cannot open the custom editor's webview
 *    and synthesize input into it, and the Playwright harness has no keybinding
 *    layer at all. The two bullets above bracket that gap from either side; the
 *    middle link is asserted by construction (`preventDefault()` suppresses the
 *    webview's unhandled-key forwarding), not by a test.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import pkg from '../../package.json';
import { createSidecarStore } from '../../src/comments/sidecar-store';
import { buildCommentLine, sidecarNameFor } from '../../src/comments/sidecar-format';
import { allowAllGuard, noopLog, openTempMdFile, withTempWorkspace, HostTestRunner } from './_harness';

function sidecarUriFor(mdUri: vscode.Uri): vscode.Uri {
  const base = mdUri.path.split('/').pop() ?? '';
  return vscode.Uri.joinPath(mdUri, '..', sidecarNameFor(base));
}

/** Same activation the rename track uses — the real `onWillRenameFiles` subscription must be live. */
async function activateExtensionUnderTest(): Promise<void> {
  const extension = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
  assert.ok(extension, `extension ${pkg.publisher}.${pkg.name} must be discoverable in this Extension Host`);
  if (!extension.isActive) {
    await extension.activate();
  }
}

export async function run(): Promise<void> {
  const runner = new HostTestRunner();

  await runner.case(
    'AC1 probe (document-level baseline): an undo command against a document with an empty undo stack mutates nothing',
    async () => {
      await withTempWorkspace(async (root) => {
        const document = await openTempMdFile(root, 'probe-untouched.md', '# doc\n\nAlpha paragraph.\n');
        await vscode.window.showTextDocument(document, { preview: false });

        const versionBefore = document.version;
        const textBefore = document.getText();
        let changeEvents = 0;
        const sub = vscode.workspace.onDidChangeTextDocument((e) => {
          if (e.document.uri.toString() === document.uri.toString()) {
            changeEvents++;
          }
        });
        try {
          await vscode.commands.executeCommand('undo');
          await new Promise<void>((r) => setTimeout(r, 50));
        } finally {
          sub.dispose();
        }

        // AC1 asserts on the DOCUMENT, not on whether a webview handler fired —
        // its whole point is that the webview-side assertion proves nothing for
        // a body-mounted field. These are that document-level assertion.
        assert.strictEqual(document.version, versionBefore, 'document.version must not move');
        assert.strictEqual(document.getText(), textBefore, 'document text must not change');
        assert.strictEqual(changeEvents, 0, 'no onDidChangeTextDocument event may fire');
      });
    }
  );

  await runner.case(
    "AC6 probe: an undo with no text edit of its own does not consume US-23.5's sidecar-rename WorkspaceEdit",
    async () => {
      await withTempWorkspace(async (root) => {
        await activateExtensionUnderTest();

        // Seed a real .md + sidecar pair, then rename it the way US-23.5 AC5
        // does — through `applyEdit`, so provider.ts's live `onWillRenameFiles`
        // contributes the sidecar half and the rename lands on the undo stack as
        // one WorkspaceEdit.
        const oldMd = vscode.Uri.joinPath(root, 'probe-rename-src.md');
        fs.writeFileSync(oldMd.fsPath, '# doc\n', 'utf8');
        const seeded = await vscode.workspace.openTextDocument(oldMd);
        const store = createSidecarStore(allowAllGuard, noopLog, false);
        assert.strictEqual(
          await store.append(
            seeded,
            buildCommentLine({
              id: 'probe-comment',
              author: 'Host Test Author',
              timestamp: '2026-01-01T00:00:00.000Z',
              body: 'survives the undo probe',
              anchor: { offset_start: 0, offset_end: 4, recorded_text: 'doc', last_known_line: 1, nearest_heading: '' },
            })
          ),
          null
        );

        const newMd = vscode.Uri.joinPath(root, 'probe-rename-dst.md');
        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(oldMd, newMd);
        assert.ok(await vscode.workspace.applyEdit(edit));
        assert.ok(fs.existsSync(newMd.fsPath), 'precondition: the rename must have applied');
        assert.ok(fs.existsSync(sidecarUriFor(newMd).fsPath), 'precondition: the sidecar must have moved with it');

        // Open the renamed file — no text edit of its own — and undo. AC6's
        // question is whether the next undo element reachable from here is the
        // rename above.
        const renamed = await vscode.workspace.openTextDocument(newMd);
        await vscode.window.showTextDocument(renamed, { preview: false });
        await vscode.commands.executeCommand('undo');
        await new Promise<void>((r) => setTimeout(r, 100));

        // If either of these fails, the probe has CONFIRMED the defect AC6 was
        // written against: an undo from this document consumed an unrelated
        // WorkspaceEdit. Per the story's PO decision, scope that fix as its own
        // follow-up pass against the failure mode observed here — do not add a
        // speculative gate to make this pass.
        assert.ok(fs.existsSync(newMd.fsPath), 'the renamed .md must still be at its destination');
        assert.ok(!fs.existsSync(oldMd.fsPath), 'the undo must not have moved the .md back');
        assert.ok(fs.existsSync(sidecarUriFor(newMd).fsPath), 'the sidecar must still be at its destination');
        assert.ok(!fs.existsSync(sidecarUriFor(oldMd).fsPath), 'the undo must not have moved the sidecar back');
      });
    }
  );

  runner.finish();
}
