// Slash commands forward `$ARGUMENTS` as a single string; direct callers may
// pass pre-split argv. Join then re-tokenize so both shapes behave the same.
export function tokenize(input) {
  const text = Array.isArray(input) ? input.join(" ") : String(input ?? "");
  const tokens = [];
  let current = "";
  let quote = null;
  let hasContent = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (hasContent) {
        tokens.push(current);
        current = "";
        hasContent = false;
      }
      continue;
    }

    current += char;
    hasContent = true;
  }

  if (hasContent) {
    tokens.push(current);
  }
  return tokens;
}

// Only a `--` that arrives before any free text is the sentinel — the same
// position rule the unknown-flag report below uses. Everything ahead of it must
// therefore be a flag, or the value of the flag just before it. (The spec is
// not known here, so a token following a `-`-token is taken for its value; a
// boolean flag's neighbour is then read as a value rather than as free text,
// which only ever makes this more permissive than `parseFlags`, and `parseFlags`
// re-decides with the real spec.)
function isFlagsOnly(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].startsWith("-")) {
      continue;
    }
    if (index > 0 && tokens[index - 1].startsWith("-")) {
      continue;
    }
    return false;
  }
  return true;
}

// `tokenize` is lossy by design (it drops quote characters and folds newlines
// into single spaces), which is fine for flags and fatal for prompt text: the
// documented single-argument form turned `Review "foo" and don't break it.` on
// three lines into one line with the quotes eaten. Splitting the raw string at
// a standalone `--` first keeps everything after it byte-for-byte.
//
// A `--` that appears *after* the free text has started is prose, not a
// sentinel: `run the suite -- then report` used to reach agy as `run the
// suite then report`, a different instruction that still reads as English.
export function splitAtSentinel(input) {
  const text = String(input ?? "");
  const match = text.match(/(^|\s)--(\s|$)/);
  if (!match) {
    return { head: text, literal: null };
  }
  const sentinelAt = match.index + match[1].length;
  const head = text.slice(0, sentinelAt);
  if (!isFlagsOnly(tokenize(head))) {
    return { head: text, literal: null };
  }
  // Drop exactly one separator after `--`; the rest of the string is verbatim.
  return {
    head,
    literal: text.slice(sentinelAt + 2).replace(/^(\r?\n|[ \t])/, "")
  };
}

// spec: { valueFlags: ["--model", ...], booleanFlags: ["--wait", ...] }
// Returns { flags, rest, errors, unknownFlags }.
// Unknown `--flags` are still treated as part of the free text so
// natural-language task text that happens to contain dashes is not swallowed —
// but one that appears *before* any free text is reported in `unknownFlags`,
// because in that position it is a mistyped flag, not prose. A leading `--`
// ends flag parsing entirely: everything after it is literal text. Once free
// text has started, a standalone `--` is part of that text like any other
// dash — it used to be consumed there too, silently deleting a word-boundary
// dash from the middle of a prompt.
export function parseFlags(tokens, spec) {
  const valueFlags = new Set(spec.valueFlags ?? []);
  const booleanFlags = new Set(spec.booleanFlags ?? []);
  const flags = new Map();
  const rest = [];
  const errors = [];
  const unknownFlags = [];
  let sawFreeText = false;
  let literal = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (literal) {
      rest.push(token);
      continue;
    }
    if (token === "--" && !sawFreeText) {
      literal = true;
      continue;
    }

    if (valueFlags.has(token)) {
      const value = tokens[index + 1];
      if (value == null || value.startsWith("--")) {
        errors.push(`${token} requires a value`);
        continue;
      }
      flags.set(token, value);
      index += 1;
      continue;
    }

    if (booleanFlags.has(token)) {
      flags.set(token, true);
      continue;
    }

    if (!sawFreeText && token.startsWith("--") && token.length > 2) {
      unknownFlags.push(token);
      rest.push(token);
      continue;
    }

    sawFreeText = true;
    rest.push(token);
  }

  return { flags, rest, errors, unknownFlags };
}
