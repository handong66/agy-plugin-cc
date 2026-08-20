import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { REPO_ROOT } from "./helpers.mjs";

function readJson(...segments) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ...segments), "utf8"));
}

// X8: the sibling repos ship `0.2.1+codex.20260711160539` in plugin.json while
// package.json says something else, so no artefact can be traced to a commit.
// This repo keeps one version in three files and no local cachebuster.
test("package, plugin manifest and marketplace agree on one clean version", () => {
  const pkg = readJson("package.json");
  const plugin = readJson("plugins", "agy", ".claude-plugin", "plugin.json");
  const marketplace = readJson(".claude-plugin", "marketplace.json");

  const versions = [
    ["package.json", pkg.version],
    ["plugins/agy/.claude-plugin/plugin.json", plugin.version],
    [".claude-plugin/marketplace.json metadata", marketplace.metadata.version],
    ...marketplace.plugins.map((entry) => [`.claude-plugin/marketplace.json ${entry.name}`, entry.version])
  ];

  for (const [name, version] of versions) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be a plain semver with no build suffix`);
    assert.equal(version, pkg.version, `${name} must match package.json`);
  }
});

// The section has to carry the release date as well as the number. A dateless
// heading is indistinguishable from an in-progress one, and this is the file a
// user reads to decide whether the version they have is the version described.
test("the changelog documents the released version, with its date", () => {
  const pkg = readJson("package.json");
  const changelog = fs.readFileSync(path.join(REPO_ROOT, "plugins", "agy", "CHANGELOG.md"), "utf8");
  const heading = new RegExp(`\\n## ${pkg.version.replace(/\\./g, "\\\\.")} — (\\d{4}-\\d{2}-\\d{2})\\n`);
  const match = changelog.match(heading);
  assert.ok(
    match,
    `plugins/agy/CHANGELOG.md needs a "## ${pkg.version} — YYYY-MM-DD" section`
  );
  assert.ok(
    !Number.isNaN(Date.parse(match[1])),
    `the release date in the ${pkg.version} heading must be a real date`
  );
});
