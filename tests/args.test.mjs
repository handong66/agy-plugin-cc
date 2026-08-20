import assert from "node:assert/strict";
import { test } from "node:test";

import { tokenize, parseFlags } from "../plugins/agy/scripts/lib/args.mjs";

test("tokenize splits on whitespace and honors quotes", () => {
  assert.deepEqual(tokenize('fix the "login page" bug'), ["fix", "the", "login page", "bug"]);
  assert.deepEqual(tokenize(["--model", "a/b"]), ["--model", "a/b"]);
  assert.deepEqual(tokenize(""), []);
});

test("parseFlags separates known flags from free text", () => {
  const { flags, rest, errors } = parseFlags(
    ["--model", "a/b", "--write", "fix", "the", "--weird", "bug"],
    { valueFlags: ["--model"], booleanFlags: ["--write"] }
  );
  assert.equal(flags.get("--model"), "a/b");
  assert.equal(flags.get("--write"), true);
  assert.deepEqual(rest, ["fix", "the", "--weird", "bug"]);
  assert.deepEqual(errors, []);
});

// The pre-split argv path never goes through `splitAtSentinel`, so the same
// position rule has to hold here: a leading `--` is the sentinel, one that
// arrives after the free text has started is a word in the prompt.
test("parseFlags only honours a leading --", () => {
  const spec = { valueFlags: ["--model"], booleanFlags: ["--write"] };

  const leading = parseFlags(["--write", "--", "--model", "text"], spec);
  assert.deepEqual(leading.rest, ["--model", "text"], "after a leading -- nothing is a flag");
  assert.equal(leading.flags.get("--write"), true);

  const inProse = parseFlags(["run", "the", "suite", "--", "then", "report"], spec);
  assert.deepEqual(inProse.rest, ["run", "the", "suite", "--", "then", "report"]);
  assert.deepEqual(inProse.unknownFlags, [], "a bare -- is never a mistyped flag");
});

test("parseFlags reports value flags missing their value", () => {
  const { errors } = parseFlags(["--model"], { valueFlags: ["--model"], booleanFlags: [] });
  assert.equal(errors.length, 1);
});
