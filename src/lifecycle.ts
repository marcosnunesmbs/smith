/**
 * Smith lifecycle management — PID file, scaffold, graceful shutdown.
 */
import fs from 'fs-extra';
import { SMITH_PATHS } from './config.js';

/** Ensure ~/.smith/ directory structure exists */
export function scaffold(): void {
  fs.ensureDirSync(SMITH_PATHS.home);
  fs.ensureDirSync(SMITH_PATHS.logs);
}

/** Write PID file. Returns true if successful, false if already running. */
export function writePid(): boolean {
  if (fs.existsSync(SMITH_PATHS.pid)) {
    const existingPid = parseInt(fs.readFileSync(SMITH_PATHS.pid, 'utf-8').trim(), 10);
    if (isProcessRunning(existingPid)) {
      return false; // another instance is running
    }
    // Stale PID file — remove it
    fs.removeSync(SMITH_PATHS.pid);
  }
  fs.writeFileSync(SMITH_PATHS.pid, String(process.pid), 'utf-8');
  return true;
}

/** Remove PID file */
export function removePid(): void {
  try {
    if (fs.existsSync(SMITH_PATHS.pid)) {
      fs.removeSync(SMITH_PATHS.pid);
    }
  } catch {
    // best-effort
  }
}

/** Check if a process with the given PID is running */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read PID from PID file, or null if not running */
export function readPid(): number | null {
  if (!fs.existsSync(SMITH_PATHS.pid)) return null;
  const pid = parseInt(fs.readFileSync(SMITH_PATHS.pid, 'utf-8').trim(), 10);
  if (isNaN(pid)) return null;
  if (!isProcessRunning(pid)) {
    fs.removeSync(SMITH_PATHS.pid); // stale
    return null;
  }
  return pid;
}
