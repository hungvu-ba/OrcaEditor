/**
 * US-23.17 AC7/AC15: `adoptDrifted`'s out-of-VS-Code drift adoption, exercised
 * against a real filesystem. Two of the four cases pin the exact data-loss
 * blockers a first review of US-23.5 found in this then-untested code
 * (`_bmad-output/quick-dev/To Be Deleted/done-23-5-comment-sidecar-persistence.md:83-86`):
 * a percent-looking real filename must never be double-decoded into a false
 * match, and a candidate whose own `.md` still exists must never be adopted.
 *
 * NFC/NFD forms: `NFC_BASE` is forced through `.normalize('NFC')` so it is
 * precomposed regardless of how this source file's own bytes are stored;
 * `NFD_BASE` is written as a literal decomposed sequence ("e" + combining
 * acute, U+0301) on purpose — not run through `.normalize('NFD')` — because
 * JS has no built-in "canonical decomposition only" normalizer that stops
 * short of NFC's own decompose-then-recompose round trip.
 *
 * Three of the four cases below depend on this filesystem keeping a
 * case/NFC-NFD-variant name as a DISTINCT directory entry from the document's
 * own expected sidecar name. Default macOS APFS folds both at the lookup
 * level (confirmed empirically — see `runner.skip()` below), which makes
 * `exists(target)` at the top of `adoptDrifted` already true before the
 * "orphan candidate" scan ever runs, so there is nothing left to adopt. Each
 * such case is named for exactly that constraint and calls `runner.skip()`
 * (a distinct, always-logged outcome — never silently counted as "ran and
 * passed") rather than returning early from inside `runner.case()`, so a
 * skip can never blend into the pass count on the very machine this repo's
 * gate runs on.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { createSidecarStore } from '../../src/comments/sidecar-store';
import { sidecarNameFor } from '../../src/comments/sidecar-format';
import { allowAllGuard, noopLog, openTempMdFile, withTempWorkspace, HostTestRunner } from './_harness';

// Built from explicit \u escapes, never a typed accented character -- this
// repo's own tooling has been observed to silently re-encode a typed accented
// character as either normalization form on different writes, which
// previously made these two constants byte-identical and broke the sanity
// check below with nobody having typed anything different.
const NFC_BASE = 'caf\u00e9.md'; // precomposed "e-acute" (U+00E9)
const NFD_BASE = 'cafe\u0301.md'; // decomposed: "e" (U+0065) + combining acute (U+0301)

function sidecarPath(root: vscode.Uri, mdName: string): string {
  return vscode.Uri.joinPath(root, sidecarNameFor(mdName)).fsPath;
}

function writeStraySidecar(root: vscode.Uri, sidecarFileName: string, body: string): void {
  fs.writeFileSync(
    vscode.Uri.joinPath(root, sidecarFileName).fsPath,
    `\n${JSON.stringify({ schema_version: 1, type: 'comment', id: 'x', author: 'a', timestamp: '2026-01-01T00:00:00.000Z', body, anchor: { offset_start: 0, offset_end: 0, recorded_text: '', last_known_line: 0, nearest_heading: '' } })}\n`,
    'utf8'
  );
}

const FS_FOLDS_NORMALIZATION_REASON =
  'this filesystem folds Unicode NFC/NFD forms at the lookup level (default macOS APFS) — cannot create two distinct dirents to adopt between';
const FS_FOLDS_CASE_REASON =
  'this filesystem folds case at the lookup level — cannot create two distinct dirents to adopt between';

export async function run(): Promise<void> {
  const runner = new HostTestRunner();

  await withTempWorkspace(async (root) => {
    assert.notStrictEqual(NFC_BASE, NFD_BASE, 'fixture sanity: NFC and NFD forms must be distinct code unit sequences');
    const nfdSidecarName = sidecarNameFor(NFD_BASE); // no paired .md on disk under this exact name -> orphaned
    writeStraySidecar(root, nfdSidecarName, 'drifted body');
    const name = 'AC7 (skips on case/NFC-NFD-folding filesystems): an orphaned NFC/NFD name-drifted sidecar is adopted';
    if (fs.existsSync(sidecarPath(root, NFC_BASE))) {
      runner.skip(name, FS_FOLDS_NORMALIZATION_REASON);
      return;
    }
    await runner.case(name, async () => {
      const document = await openTempMdFile(root, NFC_BASE);
      const store = createSidecarStore(allowAllGuard, noopLog, false);

      await store.adoptDrifted(document);

      assert.ok(fs.existsSync(sidecarPath(root, NFC_BASE)), 'the NFC sidecar name must now exist');
      assert.ok(
        !fs.existsSync(vscode.Uri.joinPath(root, nfdSidecarName).fsPath),
        'the orphaned NFD-named sidecar must be gone (renamed, not copied)'
      );
      assert.ok(fs.readFileSync(sidecarPath(root, NFC_BASE), 'utf8').includes('drifted body'));
    });
  });

  await withTempWorkspace(async (root) => {
    const nfdSidecarName = sidecarNameFor(NFD_BASE);
    // The NFD-named candidate is NOT orphaned: its own .md is really on disk.
    fs.writeFileSync(vscode.Uri.joinPath(root, NFD_BASE).fsPath, '# other doc\n', 'utf8');
    writeStraySidecar(root, nfdSidecarName, 'belongs to the other file');
    const name =
      'AC15 blocker 2 regression (skips on case/NFC-NFD-folding filesystems): a candidate whose own .md still exists is never adopted';
    if (fs.existsSync(sidecarPath(root, NFC_BASE))) {
      runner.skip(name, FS_FOLDS_NORMALIZATION_REASON);
      return;
    }
    await runner.case(name, async () => {
      const document = await openTempMdFile(root, NFC_BASE);
      const store = createSidecarStore(allowAllGuard, noopLog, false);

      await store.adoptDrifted(document);

      assert.ok(!fs.existsSync(sidecarPath(root, NFC_BASE)), 'nothing may be adopted onto the NFC document');
      assert.ok(
        fs.existsSync(vscode.Uri.joinPath(root, nfdSidecarName).fsPath),
        'the non-orphaned candidate sidecar must stay exactly where it was'
      );
    });
  });

  await runner.case(
    'AC15 blocker 1 regression: a percent-looking real filename is never double-decoded into a false match',
    async () => {
      await withTempWorkspace(async (root) => {
        const mdName = 'a b.md'; // a real space
        const strayName = sidecarNameFor('a%20b.md'); // literal percent-characters on disk, not an encoding of anything
        writeStraySidecar(root, strayName, 'unrelated file');
        const document = await openTempMdFile(root, mdName);
        const store = createSidecarStore(allowAllGuard, noopLog, false);

        await store.adoptDrifted(document);

        assert.ok(!fs.existsSync(sidecarPath(root, mdName)), '"a b.md" must never adopt "a%20b.md"\'s sidecar');
        assert.ok(fs.existsSync(vscode.Uri.joinPath(root, strayName).fsPath), 'the unrelated stray sidecar must be untouched');
      });
    }
  );

  await withTempWorkspace(async (root) => {
    const mdName = 'ambiguous.md';
    const expectedSidecar = sidecarNameFor(mdName);
    const candidateA = sidecarNameFor('AMBIGUOUS.md');
    const candidateB = sidecarNameFor('Ambiguous.md');
    writeStraySidecar(root, candidateA, 'candidate A');
    writeStraySidecar(root, candidateB, 'candidate B');
    const dirEntries = fs.readdirSync(root.fsPath);
    const name = 'AC7 (skips on case-folding filesystems): two orphaned candidates normalizing alike are left alone';
    if (!dirEntries.includes(candidateA) || !dirEntries.includes(candidateB)) {
      runner.skip(name, FS_FOLDS_CASE_REASON);
      return;
    }
    await runner.case(name, async () => {
      const document = await openTempMdFile(root, mdName);
      // caseInsensitive: true — the two candidates are ambiguous only once folded.
      const store = createSidecarStore(allowAllGuard, noopLog, true);

      await store.adoptDrifted(document);

      assert.ok(!fs.existsSync(vscode.Uri.joinPath(root, expectedSidecar).fsPath), 'ambiguous candidates must never be guessed between');
      assert.ok(fs.existsSync(vscode.Uri.joinPath(root, candidateA).fsPath));
      assert.ok(fs.existsSync(vscode.Uri.joinPath(root, candidateB).fsPath));
    });
  });

  runner.finish();
}
