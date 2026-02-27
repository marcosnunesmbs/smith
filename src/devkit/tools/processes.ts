import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import os from 'os';
import type { StructuredTool } from '@langchain/core/tools';
import type { ToolContext } from '../types.js';
import { ShellAdapter } from '../adapters/shell.js';
import { truncateOutput } from '../utils.js';
import { registerToolFactory } from '../registry.js';
import { platform } from 'os';

export function createProcessTools(ctx: ToolContext): StructuredTool[] {
  const shell = ShellAdapter.create();
  const isWindows = platform() === 'win32';

  return [
    tool(
      async ({ filter }) => {
        let result;
        if (isWindows) {
          result = await shell.run('tasklist', filter ? ['/FI', `IMAGENAME eq ${filter}*`] : [], {
            cwd: ctx.working_dir, timeout_ms: 10_000,
          });
        } else {
          result = await shell.run('ps', ['aux'], { cwd: ctx.working_dir, timeout_ms: 10_000 });
          if (filter && result.exitCode === 0) {
            result.stdout = result.stdout
              .split('\n')
              .filter((l, i) => i === 0 || l.toLowerCase().includes(filter.toLowerCase()))
              .join('\n');
          }
        }
        return truncateOutput(result.stdout || result.stderr);
      },
      {
        name: 'list_processes',
        description: 'List running processes, optionally filtered by name.',
        schema: z.object({
          filter: z.string().optional().describe('Filter by process name (partial match)'),
        }),
      }
    ),

    tool(
      async ({ pid, name }) => {
        let result;
        if (isWindows) {
          const filter = pid ? `/FI "PID eq ${pid}"` : `/FI "IMAGENAME eq ${name}*"`;
          result = await shell.run('tasklist', ['/FI', filter.replace(/"/g, '').split(' ').join(' ')], {
            cwd: ctx.working_dir, timeout_ms: 5_000,
          });
        } else {
          const query = pid ? String(pid) : name ?? '';
          result = await shell.run('ps', ['-p', query, '-o', 'pid,ppid,cmd,%cpu,%mem'], {
            cwd: ctx.working_dir, timeout_ms: 5_000,
          });
        }
        return truncateOutput(result.stdout || result.stderr);
      },
      {
        name: 'get_process',
        description: 'Get info about a specific process by PID or name.',
        schema: z.object({
          pid: z.number().int().optional().describe('Process ID'),
          name: z.string().optional().describe('Process name'),
        }),
      }
    ),

    tool(
      async ({ pid, force }) => {
        let result;
        if (isWindows) {
          const args = ['taskkill', '/PID', String(pid)];
          if (force) args.push('/F');
          result = await shell.run('taskkill', ['/PID', String(pid), ...(force ? ['/F'] : [])], {
            cwd: ctx.working_dir, timeout_ms: 10_000,
          });
        } else {
          const signal = force ? '-9' : '-15';
          result = await shell.run('kill', [signal, String(pid)], {
            cwd: ctx.working_dir, timeout_ms: 10_000,
          });
        }
        return JSON.stringify({
          success: result.exitCode === 0,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        });
      },
      {
        name: 'kill_process',
        description: 'Kill a process by PID. Use force=true for SIGKILL.',
        schema: z.object({
          pid: z.number().int().describe('Process ID to kill'),
          force: z.boolean().optional().describe('Force kill (SIGKILL / /F), default false'),
        }),
      }
    ),

    tool(
      async () => {
        const cpus = os.cpus();
        return JSON.stringify({
          platform: os.platform(),
          arch: os.arch(),
          release: os.release(),
          hostname: os.hostname(),
          cpus: cpus.length,
          cpu_model: cpus[0]?.model ?? 'unknown',
          total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
          free_memory_mb: Math.round(os.freemem() / 1024 / 1024),
          uptime_seconds: Math.round(os.uptime()),
          load_avg: os.loadavg(),
          home_dir: os.homedir(),
          tmp_dir: os.tmpdir(),
        });
      },
      {
        name: 'system_info',
        description: 'Get system information (OS, CPU, RAM, uptime).',
        schema: z.object({}),
      }
    ),

    tool(
      async ({ name, all }) => {
        if (all) return JSON.stringify(process.env);
        if (name) return JSON.stringify({ [name]: process.env[name] ?? null });
        // Return non-sensitive vars
        const safe = Object.fromEntries(
          Object.entries(process.env).filter(([k]) =>
            !k.toLowerCase().includes('key') &&
            !k.toLowerCase().includes('token') &&
            !k.toLowerCase().includes('secret') &&
            !k.toLowerCase().includes('password')
          )
        );
        return truncateOutput(JSON.stringify(safe, null, 2));
      },
      {
        name: 'env_read',
        description: 'Read environment variables. Sensitive keys (API_KEY, TOKEN, etc.) are filtered unless all=true.',
        schema: z.object({
          name: z.string().optional().describe('Specific env var name'),
          all: z.boolean().optional().describe('Include all vars including sensitive ones'),
        }),
      }
    ),
  ];
}

registerToolFactory(createProcessTools, 'processes');
