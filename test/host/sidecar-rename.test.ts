/**
 * US-23.17 AC6: US-23.5 AC5's in-VS-Code rename, exercised against a real
 * `WorkspaceEdit`. The "pair moves together" case goes through the REAL
 * registered `onWillRenameFiles` handler in `src/provider.ts` (AC6's own
 * wording: "the pair moves together via `onWillRenameFiles`") — the extension
 * under test is activated and the rename is performed with `applyEdit` alone
 * (a plain `.md`-only `renameFile`), letting the live subscription contribute
 * the sidecar half itself, exactly as it does for a real Explorer rename.
 * `onWillRenameFiles`'s own doc comment confirms `workspace.applyEdit` is one
 * of the two things that fires it (the other being a user gesture); it does
 * NOT fire for `workspace.fs`-api renames, which is why `applyEdit` is used
 * here rather than `vscode.workspace.fs.rename`.
 *
 * The destination-collision cases stay at the `sidecar-store.ts` layer,
 * calling `planRename` directly with `SidecarStoreDeps.confirmOverwrite` (an
 * injected seam) — never a real modal. `provider.ts` constructs its own
 * production `SidecarStore` internally with no test-injection point for that
 * seam, so satisfying AC6's "via `onWillRenameFiles`" and its "injected seam,
 * not a real modal" clauses together needs two different mechanisms, one per
 * clause, rather than a single unified path.
 *
 * Note on what the no-collision case does and doesn't prove: `provider.ts`'s
 * real allowed-roots guard (`isUriInsideAllowedRoots`) always includes the
 * document's own parent directory as an allowed root, ahead of any workspace
 * folder — so this case's value is exercising the real `onWillRenameFiles` →
 * `planRename` → `applyEdit` wiring itself, not proving the temp workspace
 * folder is load-bearing for that guard (it isn't, by that guard's own
 * defence-in-depth design).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import pkg from '../../package.json';
import { createSidecarStore } from '../../src/comments/sidecar-store';
import { buildCommentLine, sidecarNameFor } from '../../src/comments/sidecar-format';
import { allowAllGuard, noopLog, withTempWorkspace, HostTestRunner } from './_harness';

function sidecarUriFor(mdUri: vscode.Uri): vscode.Uri {
  const base = mdUri.path.split('/').pop() ?? '';
  return vscode.Uri.joinPath(mdUri, '..', sidecarNameFor(base));
}

/** Activates the extension under test so its real `onWillRenameFiles`/`onDidRenameFiles` subscriptions (registered unconditionally in `src/extension.ts`'s `activate()`) are live in this Extension Host. */
async function activateExtensionUnderTest(): Promise<void> {
  const extension = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
  assert.ok(extension, `extension ${pkg.publisher}.${pkg.name} must be discoverable in this Extension Host`);
  if (!extension.isActive) {
    await extension.activate();
  }
}

async function seedSidecar(root: vscode.Uri, mdName: string, body: string): Promise<vscode.Uri> {
  const mdUri = vscode.Uri.joinPath(root, mdName);
  fs.writeFileSync(mdUri.fsPath, '# doc\n', 'utf8');
  const document = await vscode.workspace.openTextDocument(mdUri);
  const store = createSidecarStore(allowAllGuard, noopLog, false);
  const err = await store.append(
    document,
    buildCommentLine({
      id: `id-${mdName}`,
      author: 'Host Test Author',
      timestamp: '2026-01-01T00:00:00.000Z',
      body,
      anchor: { offset_start: 0, offset_end: 4, recorded_text: 'doc', last_known_line: 1, nearest_heading: '' },
    })
  );
  assert.strictEqual(err, null);
  return mdUri;
}

export async function run(): Promise<void> {
  const runner = new HostTestRunner();

  await runner.case('AC6: the sidecar pair moves together via the real onWillRenameFiles handler when there is no collision', async () => {
    await withTempWorkspace(async (root) => {
      // Activated AFTER the workspace folder is added, not before: opening the
      // first folder of an otherwise-empty workspace restarts the Extension
      // Host, which would silently activate the extension in a host instance
      // about to be torn down if this ran any earlier.
      await activateExtensionUnderTest();
      const oldMd = await seedSidecar(root, 'a.md', 'source body');
      const newMd = vscode.Uri.joinPath(root, 'b.md');

      // Only the .md rename is requested — the sidecar half must come from
      // provider.ts's own live onWillRenameFiles subscription, not from any
      // call this test makes to sidecar-store.ts directly.
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(oldMd, newMd);
      assert.ok(await vscode.workspace.applyEdit(edit));

      assert.ok(fs.existsSync(newMd.fsPath), 'destination .md must exist');
      assert.ok(!fs.existsSync(oldMd.fsPath), 'source .md must be gone');
      assert.ok(fs.existsSync(sidecarUriFor(newMd).fsPath), 'destination sidecar must exist');
      assert.ok(!fs.existsSync(sidecarUriFor(oldMd).fsPath), 'source sidecar must be gone');
    });
  });

  await runner.case('AC6: accepting the collision prompt backs up the existing destination sidecar instead of deleting it', async () => {
    await withTempWorkspace(async (root) => {
      const oldMd = await seedSidecar(root, 'a2.md', 'incoming body');
      const destMd = await seedSidecar(root, 'c.md', 'existing destination body');
      const destSidecarBefore = fs.readFileSync(sidecarUriFor(destMd).fsPath, 'utf8');
      const store = createSidecarStore(allowAllGuard, noopLog, false, {
        confirmOverwrite: async () => true,
      });

      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(oldMd, destMd, { overwrite: true });
      await store.planRename(edit, oldMd, destMd);
      assert.ok(await vscode.workspace.applyEdit(edit));

      const destDir = vscode.Uri.joinPath(destMd, '..');
      const entries = await vscode.workspace.fs.readDirectory(destDir);
      const backupName = entries.map(([name]) => name).find((name) => name.includes('.bak'));
      assert.ok(backupName, 'a timestamped backup of the overwritten destination sidecar must exist');
      const backupUri = vscode.Uri.joinPath(destDir, backupName as string);
      assert.strictEqual(fs.readFileSync(backupUri.fsPath, 'utf8'), destSidecarBefore);
      assert.ok(
        fs.readFileSync(sidecarUriFor(destMd).fsPath, 'utf8').includes('incoming body'),
        'the destination sidecar must now carry the moved-in comments'
      );
    });
  });

  await runner.case('AC6: declining the collision prompt still renames the .md but leaves both sidecars untouched', async () => {
    await withTempWorkspace(async (root) => {
      const oldMd = await seedSidecar(root, 'a3.md', 'declined incoming body');
      const destMd = await seedSidecar(root, 'd.md', 'declined destination body');
      const sourceSidecarBefore = fs.readFileSync(sidecarUriFor(oldMd).fsPath, 'utf8');
      const destSidecarBefore = fs.readFileSync(sidecarUriFor(destMd).fsPath, 'utf8');
      const store = createSidecarStore(allowAllGuard, noopLog, false, {
        confirmOverwrite: async () => false,
      });

      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(oldMd, destMd, { overwrite: true });
      await store.planRename(edit, oldMd, destMd);
      assert.ok(await vscode.workspace.applyEdit(edit));

      assert.ok(fs.existsSync(destMd.fsPath), 'the .md rename is the user\'s own gesture and must still proceed');
      assert.ok(!fs.existsSync(oldMd.fsPath));
      assert.strictEqual(
        fs.readFileSync(sidecarUriFor(oldMd).fsPath, 'utf8'),
        sourceSidecarBefore,
        'a declined overwrite must leave the source sidecar exactly where it was, under its old name'
      );
      assert.strictEqual(
        fs.readFileSync(sidecarUriFor(destMd).fsPath, 'utf8'),
        destSidecarBefore,
        'a declined overwrite must never touch the existing destination sidecar'
      );
    });
  });

  runner.finish();
}
