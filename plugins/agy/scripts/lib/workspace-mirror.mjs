import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Why this file exists
// ===================
// agy offers no read-only permission mode. Measured on agy 1.1.15: without
// `--dangerously-skip-permissions` every tool call is auto-denied and the run
// ends having done nothing; `--sandbox` does not change that, and `--mode plan`
// refuses reads and shell commands as well as writes while operating out of
// ~/.gemini/antigravity-cli/scratch instead of the repository. So a run that can
// read the code can also write it, and no flag separates the two.
//
// What DOES separate them is `--add-dir`, because agy ignores the process
// working directory entirely and can only see what --add-dir hands it. A
// read-only review therefore isolates by *workspace*: agy is given a throwaway
// copy of the working tree and never the path of the real repository. The
// guarantee is a filesystem guarantee — the real tree is not reachable from any
// path the run was told about — rather than a promise about model behaviour.
//
// Deliberately a copy and not `git worktree add`:
//   * `git worktree add` writes into the user's own .git directory
//     (.git/worktrees/<name>) and leaves it there if the run crashes, which
//     would make "the repository is untouched" false in a way that is hard to
//     state honestly.
//   * A worktree checks out committed HEAD, so the uncommitted work that is
//     usually the point of the review would be missing and would have to be
//     re-applied on top — more machinery, for a tree we throw away anyway.
//   * A worktree cannot be created in a repository that has no commits yet.
// The copy costs one pass over the tracked-and-untracked file set. Both
// approaches write every file to disk, so the disk cost is comparable.

const MAX_MIRROR_FILES = 20_000;
const MAX_MIRROR_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

function gitLines(cwd, args) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

// The file set the mirror reproduces: everything git considers part of the
// working tree, in its *working-tree* state (not HEAD's), plus untracked files
// that are not ignored. Ignored files are excluded on purpose — they are build
// output, dependencies and secrets, and copying them is the expensive and
// dangerous half of a naive `cp -R`. That exclusion is a real limitation for a
// reviewer that wants to resolve imports into node_modules, and it is stated in
// the review docs rather than hidden here.
export function listMirrorFiles(repoRoot) {
  const tracked = gitLines(repoRoot, ["ls-files", "-z", "--cached"]);
  if (tracked === null) {
    return null;
  }
  const untracked = gitLines(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]) ?? [];
  const deleted = new Set(gitLines(repoRoot, ["ls-files", "-z", "--deleted"]) ?? []);
  // A file staged-as-deleted is absent from the working tree; copying it back
  // would show the reviewer a file the author has removed.
  const all = new Set([...tracked, ...untracked].filter((rel) => !deleted.has(rel)));
  return [...all];
}

function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  // git should never hand back a path that escapes the repository, but the
  // mirror writes files, so this is checked rather than assumed.
  if (target !== root && !target.startsWith(rootWithSep)) {
    return null;
  }
  return target;
}

/**
 * Builds a throwaway copy of `repoRoot`'s working tree and returns a handle.
 *
 * Returns { path, fileCount, byteCount, skipped[], degraded, cleanup() }.
 * `skipped` names every file that did not make it in and why, so a review can
 * say what it could not see instead of silently reviewing less than it claims.
 */
export function createReadOnlyMirror(repoRoot, { tmpRoot = os.tmpdir() } = {}) {
  const files = listMirrorFiles(repoRoot);
  if (files === null) {
    return null;
  }

  const mirrorPath = fs.mkdtempSync(path.join(tmpRoot, "agy-review-"));
  const skipped = [];
  // APFS is case-insensitive by default. Two tracked files differing only in
  // case collapse onto one another during the copy — silently, with no error —
  // so the reviewer would see one file where the repository has two. Detected
  // up front so it can be reported rather than discovered in a wrong finding.
  const byLowerCase = new Map();
  const caseCollisions = new Set();
  for (const rel of files) {
    const key = rel.toLowerCase();
    if (byLowerCase.has(key) && byLowerCase.get(key) !== rel) {
      caseCollisions.add(rel);
      caseCollisions.add(byLowerCase.get(key));
    } else {
      byLowerCase.set(key, rel);
    }
  }
  let fileCount = 0;
  let byteCount = 0;
  let degraded = false;

  for (const rel of files) {
    if (fileCount >= MAX_MIRROR_FILES || byteCount >= MAX_MIRROR_BYTES) {
      skipped.push({ path: rel, reason: "mirror-limit" });
      degraded = true;
      continue;
    }
    if (caseCollisions.has(rel)) {
      skipped.push({ path: rel, reason: "case-collision" });
      degraded = true;
      continue;
    }
    const source = safeJoin(repoRoot, rel);
    const target = safeJoin(mirrorPath, rel);
    if (!source || !target) {
      skipped.push({ path: rel, reason: "path-escape" });
      degraded = true;
      continue;
    }

    let stat;
    try {
      // lstat, not stat: a symlink is copied as a symlink so that one pointing
      // outside the tree stays dangling in the mirror instead of silently
      // pulling in whatever it targets.
      stat = fs.lstatSync(source);
    } catch {
      skipped.push({ path: rel, reason: "unreadable" });
      degraded = true;
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (stat.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(source);
        // A symlink reproduced verbatim keeps pointing at whatever it pointed
        // at. An absolute link, or a relative one that climbs out of the tree,
        // is a writable door straight back into the real repository — the run
        // would be isolated by path and not at all in practice. These are
        // dropped, loudly, rather than copied.
        const resolved = path.resolve(path.dirname(source), linkTarget);
        const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : `${repoRoot}${path.sep}`;
        if (path.isAbsolute(linkTarget) || !resolved.startsWith(rootWithSep)) {
          skipped.push({ path: rel, reason: "symlink-escapes-tree" });
          degraded = true;
          continue;
        }
        fs.symlinkSync(linkTarget, target);
        fileCount += 1;
        continue;
      }
      if (!stat.isFile()) {
        // Submodule roots arrive as directories here. Their contents are a
        // separate repository and are not mirrored; the review docs say so.
        skipped.push({ path: rel, reason: "not-a-regular-file" });
        degraded = true;
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        skipped.push({ path: rel, reason: "file-too-large" });
        degraded = true;
        continue;
      }
      fs.copyFileSync(source, target);
      // The executable bit survives, because whether a script is executable is
      // sometimes the thing under review.
      fs.chmodSync(target, stat.mode & 0o777);
      fileCount += 1;
      byteCount += stat.size;
    } catch (error) {
      skipped.push({ path: rel, reason: `copy-failed: ${error.code ?? error.message}` });
      degraded = true;
    }
  }

  return {
    path: mirrorPath,
    fileCount,
    byteCount,
    skipped,
    degraded,
    cleanup() {
      try {
        fs.rmSync(mirrorPath, { recursive: true, force: true });
      } catch {
        // A mirror left in the OS temp directory is litter, not a failure of
        // the review; never let cleanup mask a real result.
      }
    }
  };
}

/**
 * Fingerprints the REAL repository so a read-only run can be checked afterwards.
 *
 * The real path is never handed to agy, so these two readings must match. This
 * is defence in depth: if they ever differ, the isolation argument is wrong and
 * the user needs to be told loudly rather than handed a clean-looking verdict.
 */
export function fingerprintTree(repoRoot) {
  const status = gitLines(repoRoot, ["status", "--porcelain", "-z"]);
  if (status === null) {
    return null;
  }
  let head = null;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    // A repository with no commits has no HEAD. Not an error.
    head = null;
  }
  return { head, status: status.sort().join("\n") };
}

export function compareFingerprints(before, after) {
  if (!before || !after) {
    return null;
  }
  if (before.head === after.head && before.status === after.status) {
    return null;
  }
  return {
    class: "tree_changed_during_readonly_run",
    message:
      "tree_changed_during_readonly_run: the working tree or HEAD of the real repository changed while a read-only " +
      "review was running. The review was given a throwaway copy and was never told this repository's path, so it " +
      "should not have been able to do this — either something else changed the tree concurrently, or the isolation " +
      "this plugin relies on does not hold. Treat the verdict with suspicion and check `git status` yourself."
  };
}

/**
 * Rewrites mirror paths in rendered output back to the real repository.
 *
 * Findings cite the paths the reviewer saw, which are inside the throwaway copy
 * — paths the user cannot open and that vanish when the run ends. Only the
 * mirror prefix is rewritten, and only where it appears literally, so a finding
 * that legitimately discusses a temp directory of its own is left alone.
 */
export function rewriteMirrorPaths(text, mirrorPath, repoRoot) {
  if (!text || !mirrorPath) {
    return text;
  }
  const variants = [mirrorPath];
  // macOS hands out /var/folders/... which resolves through the /private
  // symlink; agy reports the resolved form, so both spellings must be rewritten.
  try {
    const real = fs.realpathSync(mirrorPath);
    if (real !== mirrorPath) {
      variants.push(real);
    }
  } catch {
    // The mirror may already be cleaned up; the literal prefix still applies.
  }
  let out = String(text);
  for (const variant of variants) {
    out = out.split(variant).join(repoRoot);
  }
  return out;
}

/**
 * Records what the mirror held, so writes made during a read-only run can be
 * named afterwards. Cheap: one stat per file, no content hashing.
 */
export function snapshotMirror(mirrorPath) {
  const seen = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        const stat = fs.lstatSync(full);
        seen.set(path.relative(mirrorPath, full), `${stat.size}:${stat.mtimeMs}`);
      } catch {
        // A file that vanished mid-walk is itself a change; the comparison
        // below will report it as removed.
      }
    }
  };
  walk(mirrorPath);
  return seen;
}

/**
 * Names the files a read-only run created, changed or deleted inside the copy.
 * Returns null when the run left the copy exactly as it found it.
 */
export function diffMirrorSnapshots(before, after) {
  if (!before || !after) {
    return null;
  }
  const added = [];
  const changed = [];
  const removed = [];
  for (const [rel, stamp] of after) {
    if (!before.has(rel)) {
      added.push(rel);
    } else if (before.get(rel) !== stamp) {
      changed.push(rel);
    }
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) {
      removed.push(rel);
    }
  }
  if (!added.length && !changed.length && !removed.length) {
    return null;
  }
  const parts = [];
  if (changed.length) parts.push(`modified ${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ` +${changed.length - 5} more` : ""}`);
  if (added.length) parts.push(`created ${added.slice(0, 5).join(", ")}${added.length > 5 ? ` +${added.length - 5} more` : ""}`);
  if (removed.length) parts.push(`deleted ${removed.slice(0, 5).join(", ")}${removed.length > 5 ? ` +${removed.length - 5} more` : ""}`);
  return {
    class: "readonly_run_wrote_files",
    files: { added, changed, removed },
    message:
      `readonly_run_wrote_files: this read-only run ${parts.join("; ")} — inside the disposable copy, which has now been ` +
      "deleted. Your repository was never given to it and is unchanged, so none of those edits exist. If the answer above " +
      "reads as though files were fixed, they were not. Re-run it with /agy:rescue to apply the change for real."
  };
}
