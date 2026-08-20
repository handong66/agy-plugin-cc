import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import {
  createReadOnlyMirror,
  listMirrorFiles,
  fingerprintTree,
  compareFingerprints,
  rewriteMirrorPaths,
  snapshotMirror,
  diffMirrorSnapshots
} from "../plugins/agy/scripts/lib/workspace-mirror.mjs";

// The mirror is the entire read-only guarantee. agy cannot be granted read
// without write, so if the mirror is wrong the review commands are lying about
// what they do — which makes these the most load-bearing tests in the suite.

function makeRepo(prefix = "agy-mirror-repo") {
  const dir = makeTempDir(prefix);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  return { dir, git };
}

test("the mirror reproduces the working tree, not HEAD", () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, "tracked.txt"), "committed\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  // The uncommitted edit is the thing a review usually exists to look at.
  fs.writeFileSync(path.join(dir, "tracked.txt"), "DIRTY\n");
  fs.writeFileSync(path.join(dir, "untracked.txt"), "new file\n");

  const mirror = createReadOnlyMirror(dir);
  assert.ok(mirror, "a git repository should produce a mirror");
  assert.equal(fs.readFileSync(path.join(mirror.path, "tracked.txt"), "utf8"), "DIRTY\n");
  assert.equal(fs.readFileSync(path.join(mirror.path, "untracked.txt"), "utf8"), "new file\n");
  mirror.cleanup();
  assert.equal(fs.existsSync(mirror.path), false, "cleanup removes the copy");
});

test("ignored files are left out and the omission is reported", () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, ".gitignore"), "secrets.env\n");
  fs.writeFileSync(path.join(dir, "secrets.env"), "TOKEN=hunter2\n");
  fs.writeFileSync(path.join(dir, "app.js"), "console.log(1)\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  const files = listMirrorFiles(dir);
  assert.ok(files.includes("app.js"));
  assert.equal(files.includes("secrets.env"), false, "an ignored secret must never be copied");

  const mirror = createReadOnlyMirror(dir);
  assert.equal(fs.existsSync(path.join(mirror.path, "secrets.env")), false);
  mirror.cleanup();
});

test("a file staged as deleted is absent from the mirror", () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, "gone.txt"), "bye\n");
  fs.writeFileSync(path.join(dir, "stays.txt"), "hi\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  git("rm", "-q", "gone.txt");

  const mirror = createReadOnlyMirror(dir);
  assert.equal(fs.existsSync(path.join(mirror.path, "gone.txt")), false, "a removed file must not reappear");
  assert.ok(fs.existsSync(path.join(mirror.path, "stays.txt")));
  mirror.cleanup();
});

test("a symlink pointing outside the tree is dropped, not reproduced", () => {
  // Reproduced verbatim, such a link is a writable door from the throwaway copy
  // straight back into the real repository — the isolation would be nominal.
  const { dir, git } = makeRepo();
  const outside = makeTempDir("agy-mirror-outside");
  fs.writeFileSync(path.join(outside, "target.txt"), "outside content\n");
  fs.writeFileSync(path.join(dir, "keep.txt"), "ok\n");
  fs.symlinkSync(path.join(outside, "target.txt"), path.join(dir, "escape-abs"));
  fs.symlinkSync(path.relative(dir, path.join(outside, "target.txt")), path.join(dir, "escape-rel"));
  fs.symlinkSync("keep.txt", path.join(dir, "inside-link"));
  git("add", "-A");
  git("commit", "-qm", "init");

  const mirror = createReadOnlyMirror(dir);
  const reasons = new Map(mirror.skipped.map((entry) => [entry.path, entry.reason]));
  assert.equal(reasons.get("escape-abs"), "symlink-escapes-tree");
  assert.equal(reasons.get("escape-rel"), "symlink-escapes-tree");
  assert.equal(fs.existsSync(path.join(mirror.path, "escape-abs")), false);
  assert.equal(fs.existsSync(path.join(mirror.path, "escape-rel")), false);
  // A link that stays inside the tree is still a real part of the code.
  assert.equal(fs.lstatSync(path.join(mirror.path, "inside-link")).isSymbolicLink(), true);
  assert.equal(mirror.degraded, true, "dropping files must mark the mirror degraded");
  mirror.cleanup();
});

test("the executable bit survives the copy", () => {
  const { dir, git } = makeRepo();
  const script = path.join(dir, "run.sh");
  fs.writeFileSync(script, "#!/bin/sh\necho hi\n");
  fs.chmodSync(script, 0o755);
  git("add", "-A");
  git("commit", "-qm", "init");

  const mirror = createReadOnlyMirror(dir);
  assert.equal(fs.statSync(path.join(mirror.path, "run.sh")).mode & 0o111, 0o111);
  mirror.cleanup();
});

test("a directory that is not a git repository yields no mirror", () => {
  // Refusing is the honest move: the alternative is handing agy the real tree
  // while the command still calls itself read-only.
  assert.equal(createReadOnlyMirror(makeTempDir("agy-not-a-repo")), null);
});

test("a repository with no commits still mirrors its staged work", () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, "first.txt"), "before any commit\n");
  git("add", "-A");

  const mirror = createReadOnlyMirror(dir);
  assert.ok(mirror, "a fresh repository with no HEAD must still be reviewable");
  assert.equal(fs.readFileSync(path.join(mirror.path, "first.txt"), "utf8"), "before any commit\n");
  mirror.cleanup();
});

test("the mirror carries no .git, so it shares no refs with the repository", () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  const mirror = createReadOnlyMirror(dir);
  assert.equal(fs.existsSync(path.join(mirror.path, ".git")), false);
  mirror.cleanup();
});

test("an unchanged repository fingerprints identically; a touched one does not", () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  const before = fingerprintTree(dir);
  assert.equal(compareFingerprints(before, fingerprintTree(dir)), null, "an untouched tree raises nothing");

  fs.writeFileSync(path.join(dir, "b.txt"), "new\n");
  const warning = compareFingerprints(before, fingerprintTree(dir));
  assert.equal(warning?.class, "tree_changed_during_readonly_run");
});

test("mirror paths in findings are rewritten back to the repository", () => {
  const rewritten = rewriteMirrorPaths(
    "Bug at /tmp/agy-review-abc/src/retry.mjs:42 — see /tmp/agy-review-abc/src/retry.mjs",
    "/tmp/agy-review-abc",
    "/home/me/project"
  );
  assert.equal(rewritten.includes("/tmp/agy-review-abc"), false, "no copy path may survive into the output");
  assert.equal(rewritten.includes("/home/me/project/src/retry.mjs:42"), true);
});

test("path rewriting leaves unrelated temp paths alone", () => {
  const text = "The cache in /tmp/other-thing/x is fine.";
  assert.equal(rewriteMirrorPaths(text, "/tmp/agy-review-abc", "/home/me/project"), text);
});

test("writes made inside the copy are named, because they are about to vanish", () => {
  // Findings are rewritten from copy paths back to repository paths, so a run
  // that says "fixed it" and names the user's file reads exactly like a run
  // that changed the user's file. This is the disclosure that separates them,
  // and it is a filesystem fact rather than a guess about what the model meant.
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, "app.js"), "original\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  const mirror = createReadOnlyMirror(dir);
  const before = snapshotMirror(mirror.path);
  assert.equal(diffMirrorSnapshots(before, snapshotMirror(mirror.path)), null, "an untouched copy discloses nothing");

  fs.writeFileSync(path.join(mirror.path, "app.js"), "edited by the reviewer\n");
  fs.writeFileSync(path.join(mirror.path, "notes.md"), "new\n");
  const disclosure = diffMirrorSnapshots(before, snapshotMirror(mirror.path));
  assert.equal(disclosure?.class, "readonly_run_wrote_files");
  assert.deepEqual(disclosure.files.changed, ["app.js"]);
  assert.deepEqual(disclosure.files.added, ["notes.md"]);
  assert.match(disclosure.message, /none of those edits exist/);

  // The real repository is untouched throughout — that is the whole point.
  assert.equal(fs.readFileSync(path.join(dir, "app.js"), "utf8"), "original\n");
  mirror.cleanup();
});
