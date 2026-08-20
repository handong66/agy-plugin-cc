export const SESSION_ID_ENV = "AGY_COMPANION_SESSION_ID";
export const TRANSCRIPT_PATH_ENV = "AGY_COMPANION_TRANSCRIPT_PATH";
// Namespaced snapshot of this plugin's data dir. CLAUDE_PLUGIN_DATA is only
// reliable inside our own hook processes; in the shared session env file any
// plugin that exports it last wins (the Codex plugin does exactly that), so
// commands must read the namespaced variable instead.
export const DATA_DIR_ENV = "AGY_COMPANION_DATA_DIR";
export const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
// Set by a parent that has already run the readiness probe (`agy
// --version` + `agy auth list`, ~1.1s) so the child does not repeat it.
// Only ever set by this plugin's own hooks for a process they spawn.
export const READY_ENV = "AGY_COMPANION_READY";
// Absolute path to this plugin's companion script, exported at SessionStart so
// callers never have to guess it. Orchestrators hard-coded a versioned cache
// path (`.../agy/0.1.0/scripts/...`), guessed one that did not exist, and
// fell back to `find | head -1` — which pinned a session to an old version for
// 3.5 hours. Falls back to ${CLAUDE_PLUGIN_ROOT} when the env file was not read.
export const COMPANION_BIN_ENV = "AGY_COMPANION_BIN";
