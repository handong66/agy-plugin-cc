function signalTarget(target, signal) {
  try {
    process.kill(target, signal);
    return true;
  } catch {
    return false;
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepMs(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

// Jobs spawn agy detached so the child owns its process group; signal the
// group first, then the pid itself as a fallback.
export function terminateProcessTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  const terminated = signalTarget(-pid, "SIGTERM");
  const terminatedDirect = signalTarget(pid, "SIGTERM");
  if (!terminated && !terminatedDirect) {
    return false;
  }

  sleepMs(500);
  if (isAlive(pid)) {
    signalTarget(-pid, "SIGKILL");
    signalTarget(pid, "SIGKILL");
  }
  return true;
}
