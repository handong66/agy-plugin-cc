import { execFileSync } from "node:child_process";

export function resolveWorkspaceRoot(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return out || cwd;
  } catch {
    return cwd;
  }
}
