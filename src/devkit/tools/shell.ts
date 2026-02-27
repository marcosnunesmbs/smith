import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import type { StructuredTool } from '@langchain/core/tools';
import type { ToolContext } from '../types.js';
import { ShellAdapter } from '../adapters/shell.js';
import { truncateOutput, isCommandAllowed, isWithinDir } from '../utils.js';
import { registerToolFactory } from '../registry.js';

export function createShellTools(ctx: ToolContext): StructuredTool[] {
  const shell = ShellAdapter.create();

  return [
    tool(
      async ({ command, args, timeout_ms, cwd }) => {
        if (!isCommandAllowed(command, ctx.allowed_commands)) {
          return JSON.stringify({
            success: false,
            error: `Command '${command}' is not in the allowed_commands list for this project. Allowed: [${ctx.allowed_commands.join(', ')}]`,
          });
        }

        // Enforce sandbox_dir: override cwd to stay within sandbox
        let effectiveCwd = cwd ?? ctx.working_dir;
        if (ctx.sandbox_dir) {
          const resolvedCwd = path.isAbsolute(effectiveCwd) ? effectiveCwd : path.resolve(ctx.sandbox_dir, effectiveCwd);
          if (!isWithinDir(resolvedCwd, ctx.sandbox_dir)) {
            return JSON.stringify({
              success: false,
              error: `Working directory '${resolvedCwd}' is outside the sandbox directory '${ctx.sandbox_dir}'. Operation denied.`,
            });
          }
          effectiveCwd = resolvedCwd;
        }

        const result = await shell.run(command, args ?? [], {
          cwd: effectiveCwd,
          timeout_ms: timeout_ms ?? ctx.timeout_ms ?? 30_000,
        });

        return JSON.stringify({
          success: result.exitCode === 0,
          stdout: truncateOutput(result.stdout),
          stderr: truncateOutput(result.stderr),
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        });
      },
      {
        name: 'run_command',
        description: 'Run a shell command. The command binary must be in the project allowlist.',
        schema: z.object({
          command: z.string().describe('Command/binary to run'),
          args: z.array(z.string()).optional().describe('Arguments array'),
          timeout_ms: z.number().optional().describe('Override timeout in milliseconds'),
          cwd: z.string().optional().describe('Override working directory'),
        }),
      }
    ),

    tool(
      async ({ script, language, timeout_ms }) => {
        const lang = language ?? 'bash';
        const ext = lang === 'python' ? 'py' : lang === 'node' ? 'js' : 'sh';
        const tmpFile = path.join(os.tmpdir(), `smith-script-${randomUUID()}.${ext}`);

        try {
          await fs.writeFile(tmpFile, script, 'utf8');

          const binaryMap: Record<string, string> = {
            bash: 'bash',
            python: 'python3',
            node: 'node',
            sh: 'sh',
          };

          const binary = binaryMap[lang] ?? lang;

          if (!isCommandAllowed(binary, ctx.allowed_commands)) {
            return JSON.stringify({
              success: false,
              error: `Script runtime '${binary}' is not in the allowed_commands list.`,
            });
          }

          const result = await shell.run(binary, [tmpFile], {
            cwd: ctx.working_dir,
            timeout_ms: timeout_ms ?? ctx.timeout_ms ?? 60_000,
          });

          return JSON.stringify({
            success: result.exitCode === 0,
            stdout: truncateOutput(result.stdout),
            stderr: truncateOutput(result.stderr),
            exitCode: result.exitCode,
            timedOut: result.timedOut,
          });
        } finally {
          await fs.remove(tmpFile).catch(() => {});
        }
      },
      {
        name: 'run_script',
        description: 'Write and execute an inline script (bash, python, node, sh).',
        schema: z.object({
          script: z.string().describe('Script content to execute'),
          language: z.enum(['bash', 'python', 'node', 'sh']).optional().describe('Script language, default bash'),
          timeout_ms: z.number().optional(),
        }),
      }
    ),

    tool(
      async ({ binary }) => {
        const location = await shell.which(binary);
        return JSON.stringify({ found: Boolean(location), path: location });
      },
      {
        name: 'which',
        description: 'Find the location of a binary in the system PATH.',
        schema: z.object({ binary: z.string() }),
      }
    ),
  ];
}

registerToolFactory(createShellTools, 'shell');
