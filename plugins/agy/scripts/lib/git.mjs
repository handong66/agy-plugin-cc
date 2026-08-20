import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MAX_REVIEW_INPUT_CHARS = 180_000;
const MAX_UNTRACKED_FILES_INLINED = 10;
const MAX_UNTRACKED_FILE_BYTES = 20_000;

function git(cwd, args) {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return "";
  }
}

export function isGitRepository(cwd) {
  try {
    return git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

function refExists(cwd, ref) {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, 1024);
  return sample.includes(0);
}

function section(title, body) {
  const trimmed = String(body ?? "").trimEnd();
  if (!trimmed) {
    return "";
  }
  return `## ${title}\n\n${trimmed}\n`;
}

function collectUntracked(cwd, paths = []) {
  const raw = tryGit(cwd, ["ls-files", "--others", "--exclude-standard", ...(paths.length > 0 ? ["--", ...paths] : [])]);
  const files = raw.split("\n").filter(Boolean);
  if (files.length === 0) {
    return { list: "", contents: "", count: 0 };
  }

  const parts = [];
  let inlined = 0;
  for (const file of files) {
    if (inlined >= MAX_UNTRACKED_FILES_INLINED) {
      break;
    }
    const absolute = path.join(cwd, file);
    let buffer;
    try {
      const stats = fs.statSync(absolute);
      if (!stats.isFile() || stats.size > MAX_UNTRACKED_FILE_BYTES) {
        continue;
      }
      buffer = fs.readFileSync(absolute);
    } catch {
      continue;
    }
    if (looksBinary(buffer)) {
      continue;
    }
    inlined += 1;
    parts.push(`### New file: ${file}\n\n\`\`\`\n${buffer.toString("utf8")}\n\`\`\``);
  }

  return {
    list: files.join("\n"),
    contents: parts.join("\n\n"),
    count: files.length
  };
}

// Real review requests are commit ranges and file sets — `git diff A..B`,
// `git diff 4e590f7..HEAD`, "the documents under docs/, committed". The old
// selector could only express "working tree" or "<base>...HEAD", so every
// caller rebuilt the review by hand and the command itself went unused.
export function parseRange(spec) {
  const text = String(spec ?? "").trim();
  const threeDot = text.includes("...");
  const separator = threeDot ? "..." : text.includes("..") ? ".." : null;
  if (!separator) {
    return null;
  }
  const [left, right] = text.split(separator);
  return {
    base: left.trim() || "HEAD",
    head: right.trim() || "HEAD",
    // `A..B` is "commits on B not on A"; `A...B` is the merge-base form, which
    // is what a branch review wants. Whichever the caller wrote is honoured.
    symmetric: threeDot
  };
}

// Builds the inline repository context fed to the review prompt. agy also
// gets read access to the checkout, but the diff travels in the prompt so the
// review works even when tool use is restricted.
export function collectReviewInput(cwd, { base = null, head = null, scope = "auto", paths = [] } = {}) {
  if (!isGitRepository(cwd)) {
    throw new Error("Not a git repository. Run the review from inside a git checkout.");
  }

  // `--base A..B` / `--base A...B` is accepted because that is how the request
  // arrives in practice, and because typing it into `--base` alone otherwise
  // produces "Base ref not found: A..B".
  const range = parseRange(base);
  let symmetric = true;
  if (range) {
    base = range.base;
    head = head ?? range.head;
    symmetric = range.symmetric;
  }
  const headRef = head ?? "HEAD";
  const pathspec = paths.length > 0 ? ["--", ...paths] : [];
  const pathLabel = paths.length > 0 ? ` limited to ${paths.join(", ")}` : "";

  const useBranch = Boolean(base) || scope === "branch";
  if (scope === "branch" && !base) {
    throw new Error("--scope branch requires --base <ref> (or a range such as --base main..HEAD).");
  }
  // `--head` names *one end* of a range, so on its own there is nothing to diff
  // against. The branch arm used to be gated on `--base` alone, which meant a
  // caller who wrote `review --head <sha>` — the form the slash commands now
  // advertise — got a working-tree review of their dirty files instead, with no
  // error and no warning. Same silent-argument-drop family the unknown-flag
  // rejection was added for; say so rather than reviewing something else.
  if (head && !useBranch) {
    throw new Error(
      "--head <ref> names one end of a commit range; pass --base <ref> as well (or write the whole range as --base A..B)."
    );
  }

  let label;
  let body;
  if (useBranch) {
    for (const ref of [base, headRef]) {
      if (!refExists(cwd, ref)) {
        throw new Error(`Ref not found: ${ref}`);
      }
    }
    const diffSpec = `${base}${symmetric ? "..." : ".."}${headRef}`;
    label = `diff ${diffSpec}${pathLabel}`;
    const log = tryGit(cwd, ["log", "--oneline", `${base}..${headRef}`, ...pathspec]);
    const diff = tryGit(cwd, ["diff", diffSpec, ...pathspec]);
    if (!diff.trim() && !log.trim()) {
      return { label, input: "", isEmpty: true, truncated: false };
    }
    body = [section("Commits in range", log), section(`Diff (${diffSpec})`, diff)].filter(Boolean).join("\n");
  } else {
    label = `uncommitted working tree changes${pathLabel}`;
    const status = tryGit(cwd, ["status", "--short", "--untracked-files=all", ...pathspec]);
    const staged = tryGit(cwd, ["diff", "--cached", ...pathspec]);
    const unstaged = tryGit(cwd, ["diff", ...pathspec]);
    const untracked = collectUntracked(cwd, paths);
    if (!staged.trim() && !unstaged.trim() && untracked.count === 0) {
      return { label, input: "", isEmpty: true, truncated: false };
    }
    body = [
      section("git status", status),
      section("Staged diff", staged),
      section("Unstaged diff", unstaged),
      section("Untracked files", untracked.list),
      section("Untracked file contents", untracked.contents)
    ]
      .filter(Boolean)
      .join("\n");
  }

  let input = body;
  // Truncation used to exist only as a sentence inside the prompt, where the
  // caller never saw it and the model was left to mention it or not.
  const truncated = input.length > MAX_REVIEW_INPUT_CHARS;
  if (truncated) {
    input = `${input.slice(0, MAX_REVIEW_INPUT_CHARS)}\n\n[Review input truncated at ${MAX_REVIEW_INPUT_CHARS} characters. Use the repository checkout to inspect the rest.]`;
  }

  return { label, input, isEmpty: false, truncated, truncatedAtChars: truncated ? MAX_REVIEW_INPUT_CHARS : null, totalChars: body.length };
}
