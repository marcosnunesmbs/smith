import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredTool } from '@langchain/core/tools';
import type { ToolContext } from '../types.js';
import { ShellAdapter } from '../adapters/shell.js';
import { truncateOutput, isCommandAllowed } from '../utils.js';
import { registerToolFactory } from '../registry.js';

export function createPackageTools(ctx: ToolContext): StructuredTool[] {
  const shell = ShellAdapter.create();

  async function run(binary: string, args: string[], timeout_ms?: number) {
    if (!isCommandAllowed(binary, ctx.allowed_commands)) {
      return `'${binary}' is not in the allowed_commands list.`;
    }
    const result = await shell.run(binary, args, {
      cwd: ctx.working_dir,
      timeout_ms: timeout_ms ?? ctx.timeout_ms ?? 120_000,
    });
    return truncateOutput(result.stdout + (result.stderr ? '\n' + result.stderr : ''));
  }

  return [
    tool(
      async ({ packages, save_dev, timeout_ms }) => {
        const args = ['install'];
        if (packages?.length) args.push(...packages);
        if (save_dev) args.push('--save-dev');
        return run('npm', args, timeout_ms);
      },
      {
        name: 'npm_install',
        description: 'Install npm packages. Runs "npm install [packages]".',
        schema: z.object({
          packages: z.array(z.string()).optional().describe('Specific packages to install, omit to install all from package.json'),
          save_dev: z.boolean().optional().describe('Install as devDependency'),
          timeout_ms: z.number().optional(),
        }),
      }
    ),

    tool(
      async ({ script, args, timeout_ms }) => {
        const npmArgs = ['run', script];
        if (args?.length) npmArgs.push('--', ...args);
        return run('npm', npmArgs, timeout_ms);
      },
      {
        name: 'npm_run',
        description: 'Run an npm script defined in package.json.',
        schema: z.object({
          script: z.string().describe('Script name from package.json'),
          args: z.array(z.string()).optional().describe('Additional arguments after --'),
          timeout_ms: z.number().optional(),
        }),
      }
    ),

    tool(
      async ({ packages, upgrade, timeout_ms }) => {
        const args = [upgrade ? 'install' : 'install', '--upgrade', ...packages];
        return run('pip3', packages.length ? ['install', ...packages] : ['install', '-r', 'requirements.txt'], timeout_ms);
      },
      {
        name: 'pip_install',
        description: 'Install Python packages with pip3.',
        schema: z.object({
          packages: z.array(z.string()).default([]).describe('Package names, omit to use requirements.txt'),
          upgrade: z.boolean().optional().describe('Upgrade packages if already installed'),
          timeout_ms: z.number().optional(),
        }),
      }
    ),

    tool(
      async ({ args, timeout_ms }) => {
        return run('cargo', ['build', ...(args ?? [])], timeout_ms);
      },
      {
        name: 'cargo_build',
        description: 'Build a Rust project using cargo.',
        schema: z.object({
          args: z.array(z.string()).optional().describe('Additional cargo build arguments'),
          timeout_ms: z.number().optional(),
        }),
      }
    ),
  ];
}

registerToolFactory(createPackageTools, 'packages');
