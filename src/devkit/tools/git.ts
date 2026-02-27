import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import path from 'path';
import type { StructuredTool } from '@langchain/core/tools';
import type { ToolContext } from '../types.js';
import { ShellAdapter } from '../adapters/shell.js';
import { truncateOutput, isCommandAllowed, isWithinDir } from '../utils.js';
import { registerToolFactory } from '../registry.js';

export function createGitTools(ctx: ToolContext): StructuredTool[] {
  const shell = ShellAdapter.create();

  async function git(args: string[], cwd?: string): Promise<{ success: boolean; output: string }> {
    if (!isCommandAllowed('git', ctx.allowed_commands)) {
      return { success: false, output: `'git' is not in the allowed_commands list.` };
    }
    const result = await shell.run('git', args, {
      cwd: cwd ?? ctx.working_dir,
      timeout_ms: ctx.timeout_ms ?? 30_000,
    });
    return {
      success: result.exitCode === 0,
      output: truncateOutput(result.stdout + (result.stderr ? '\n' + result.stderr : '')),
    };
  }

  return [
    tool(
      async ({ short }) => {
        const r = await git(short ? ['status', '-s'] : ['status']);
        return r.output;
      },
      {
        name: 'git_status',
        description: 'Show the working tree status.',
        schema: z.object({ short: z.boolean().optional().describe('Short format') }),
      }
    ),

    tool(
      async ({ staged, file, base_branch }) => {
        const args = ['diff'];
        if (staged) args.push('--staged');
        if (base_branch) args.push(base_branch);
        if (file) args.push('--', file);
        const r = await git(args);
        return r.output;
      },
      {
        name: 'git_diff',
        description: 'Show changes between commits, commit and working tree, etc.',
        schema: z.object({
          staged: z.boolean().optional().describe('Show staged changes'),
          file: z.string().optional().describe('Specific file'),
          base_branch: z.string().optional().describe('Compare against this branch'),
        }),
      }
    ),

    tool(
      async ({ max_count, oneline, author, since }) => {
        const args = ['log'];
        if (max_count) args.push(`-${max_count}`);
        if (oneline) args.push('--oneline');
        if (author) args.push(`--author=${author}`);
        if (since) args.push(`--since=${since}`);
        const r = await git(args);
        return r.output;
      },
      {
        name: 'git_log',
        description: 'Show commit logs.',
        schema: z.object({
          max_count: z.number().int().optional().describe('Limit number of commits'),
          oneline: z.boolean().optional(),
          author: z.string().optional(),
          since: z.string().optional().describe('e.g. "2 weeks ago"'),
        }),
      }
    ),

    tool(
      async ({ files }) => {
        const args = ['add', ...(files ?? ['.'])];
        const r = await git(args);
        return JSON.stringify({ success: r.success, output: r.output });
      },
      {
        name: 'git_add',
        description: 'Stage files for commit.',
        schema: z.object({
          files: z.array(z.string()).optional().describe('Files to stage, defaults to all (".")'),
        }),
      }
    ),

    tool(
      async ({ message, allow_empty }) => {
        const args = ['commit', '-m', message];
        if (allow_empty) args.push('--allow-empty');
        const r = await git(args);
        return JSON.stringify({ success: r.success, output: r.output });
      },
      {
        name: 'git_commit',
        description: 'Create a commit with the staged changes.',
        schema: z.object({
          message: z.string().describe('Commit message'),
          allow_empty: z.boolean().optional(),
        }),
      }
    ),

    tool(
      async ({ remote, branch, force }) => {
        const args = ['push'];
        if (remote) args.push(remote);
        if (branch) args.push(branch);
        if (force) args.push('--force-with-lease');
        const r = await git(args);
        return JSON.stringify({ success: r.success, output: r.output });
      },
      {
        name: 'git_push',
        description: 'Push commits to the remote repository.',
        schema: z.object({
          remote: z.string().optional().describe('Remote name, default origin'),
          branch: z.string().optional().describe('Branch to push'),
          force: z.boolean().optional().describe('Force push with lease (safer)'),
        }),
      }
    ),

    tool(
      async ({ remote, branch, rebase }) => {
        const args = ['pull'];
        if (remote) args.push(remote);
        if (branch) args.push(branch);
        if (rebase) args.push('--rebase');
        const r = await git(args);
        return JSON.stringify({ success: r.success, output: r.output });
      },
      {
        name: 'git_pull',
        description: 'Fetch and merge changes from remote.',
        schema: z.object({
          remote: z.string().optional(),
          branch: z.string().optional(),
          rebase: z.boolean().optional(),
        }),
      }
    ),

    tool(
      async ({ target, create }) => {
        const args = ['checkout'];
        if (create) args.push('-b');
        args.push(target);
        const r = await git(args);
        return JSON.stringify({ success: r.success, output: r.output });
      },
      {
        name: 'git_checkout',
        description: 'Switch branches or restore files.',
        schema: z.object({
          target: z.string().describe('Branch name or file path'),
          create: z.boolean().optional().describe('Create the branch if it does not exist'),
        }),
      }
    ),

    tool(
      async ({ branch_name, from }) => {
        const args = ['checkout', '-b', branch_name];
        if (from) args.push(from);
        const r = await git(args);
        return JSON.stringify({ success: r.success, output: r.output });
      },
      {
        name: 'git_create_branch',
        description: 'Create a new git branch.',
        schema: z.object({
          branch_name: z.string(),
          from: z.string().optional().describe('Base branch or commit'),
        }),
      }
    ),

    tool(
      async ({ message, pop }) => {
        const args = pop ? ['stash', 'pop'] : ['stash', 'push'];
        if (!pop && message) args.push('-m', message);
        const r = await git(args);
        return JSON.stringify({ success: r.success, output: r.output });
      },
      {
        name: 'git_stash',
        description: 'Stash working directory changes or pop the last stash.',
        schema: z.object({
          message: z.string().optional(),
          pop: z.boolean().optional().describe('Pop the last stash instead of creating'),
        }),
      }
    ),

    tool(
      async ({ url, destination, depth }) => {
        const args = ['clone', url];
        if (destination) {
          // Enforce sandbox_dir on clone destination
          if (ctx.sandbox_dir) {
            const resolvedDest = path.isAbsolute(destination) ? destination : path.resolve(ctx.working_dir, destination);
            if (!isWithinDir(resolvedDest, ctx.sandbox_dir)) {
              return JSON.stringify({ success: false, output: `Clone destination '${resolvedDest}' is outside the sandbox directory '${ctx.sandbox_dir}'. Operation denied.` });
            }
          }
          args.push(destination);
        }
        if (depth) args.push('--depth', String(depth));
        const r = await git(args);
        return JSON.stringify({ success: r.success, output: r.output });
      },
      {
        name: 'git_clone',
        description: 'Clone a git repository.',
        schema: z.object({
          url: z.string().describe('Repository URL'),
          destination: z.string().optional().describe('Target directory'),
          depth: z.number().int().optional().describe('Shallow clone depth'),
        }),
      }
    ),

    tool(
      async ({ path: worktreePath, branch }) => {
        // Enforce sandbox_dir on worktree path
        if (ctx.sandbox_dir) {
          const resolvedPath = path.isAbsolute(worktreePath) ? worktreePath : path.resolve(ctx.working_dir, worktreePath);
          if (!isWithinDir(resolvedPath, ctx.sandbox_dir)) {
            return JSON.stringify({ success: false, output: `Worktree path '${resolvedPath}' is outside the sandbox directory '${ctx.sandbox_dir}'. Operation denied.` });
          }
        }
        const args = ['worktree', 'add', worktreePath];
        if (branch) args.push('-b', branch);
        const r = await git(args);
        return JSON.stringify({ success: r.success, output: r.output });
      },
      {
        name: 'git_worktree_add',
        description: 'Add a new git worktree for parallel development.',
        schema: z.object({
          path: z.string().describe('Path for the new worktree'),
          branch: z.string().optional().describe('New branch to create in the worktree'),
        }),
      }
    ),
  ];
}

registerToolFactory(createGitTools, 'git');
