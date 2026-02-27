import { platform } from 'os';

export interface ShellRunOptions {
  cwd: string;
  timeout_ms: number;
  env?: Record<string, string>;
}

export interface ShellRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export abstract class ShellAdapter {
  abstract run(command: string, args: string[], options: ShellRunOptions): Promise<ShellRunResult>;
  abstract which(binary: string): Promise<string | null>;
  abstract getShell(): { shell: string; flag: string };

  /**
   * Factory: returns the appropriate adapter for the current OS.
   * Uses direct imports (ESM-compatible, no require()).
   */
  static create(): ShellAdapter {
    switch (platform()) {
      case 'win32': return new WindowsAdapter();
      case 'darwin': return new MacAdapter();
      default: return new LinuxAdapter();
    }
  }
}

// ─── Inline implementations (avoids ESM dynamic import issues) ────────────────

import { spawn } from 'child_process';

class WindowsAdapter extends ShellAdapter {
  getShell() { return { shell: 'cmd.exe', flag: '/c' }; }

  async run(command: string, args: string[], options: ShellRunOptions): Promise<ShellRunResult> {
    return spawnCommand(command, args, { ...options, windowsHide: true, shell: true });
  }

  async which(binary: string): Promise<string | null> {
    const result = await this.run('where', [binary], { cwd: process.cwd(), timeout_ms: 5000 });
    if (result.exitCode !== 0) return null;
    const first = result.stdout.trim().split(/\r?\n/)[0];
    return first || null;
  }
}

class LinuxAdapter extends ShellAdapter {
  getShell() { return { shell: '/bin/bash', flag: '-c' }; }

  async run(command: string, args: string[], options: ShellRunOptions): Promise<ShellRunResult> {
    return spawnCommand(command, args, { ...options, shell: false });
  }

  async which(binary: string): Promise<string | null> {
    const result = await this.run('which', [binary], { cwd: process.cwd(), timeout_ms: 5000 });
    if (result.exitCode !== 0) return null;
    return result.stdout.trim() || null;
  }
}

class MacAdapter extends ShellAdapter {
  getShell() { return { shell: '/bin/zsh', flag: '-c' }; }

  async run(command: string, args: string[], options: ShellRunOptions): Promise<ShellRunResult> {
    return spawnCommand(command, args, { ...options, shell: false });
  }

  async which(binary: string): Promise<string | null> {
    const result = await this.run('which', [binary], { cwd: process.cwd(), timeout_ms: 5000 });
    if (result.exitCode !== 0) return null;
    return result.stdout.trim() || null;
  }
}

// ─── Shared spawn helper ──────────────────────────────────────────────────────

interface SpawnOptions extends ShellRunOptions {
  shell?: boolean;
  windowsHide?: boolean;
}

function spawnCommand(
  command: string,
  args: string[],
  options: SpawnOptions
): Promise<ShellRunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: options.shell ?? false,
      windowsHide: options.windowsHide ?? false,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeout_ms);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: stderr + err.message, timedOut });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
    });
  });
}
