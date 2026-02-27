import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import type { StructuredTool } from '@langchain/core/tools';
import type { ToolContext } from '../types.js';
import { truncateOutput, isWithinDir } from '../utils.js';
import { registerToolFactory } from '../registry.js';

function resolveSafe(ctx: ToolContext, filePath: string): string {
  // Resolve relative to sandbox_dir (preferred) or working_dir
  const base = ctx.sandbox_dir || ctx.working_dir;
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(base, filePath);
  return resolved;
}

/**
 * Guards a resolved path against the sandbox directory.
 * When sandbox_dir is set, ALL paths (read and write) must be within it.
 * When readonly_mode is true, destructive operations are blocked.
 */
function guardPath(ctx: ToolContext, resolved: string, destructive = false): void {
  // Enforce readonly_mode for destructive operations
  if (destructive && ctx.readonly_mode) {
    throw new Error(`Operation denied: DevKit is in read-only mode. Write/delete operations are blocked.`);
  }
  // Enforce sandbox_dir for ALL operations (read and write)
  if (ctx.sandbox_dir && !isWithinDir(resolved, ctx.sandbox_dir)) {
    throw new Error(`Path '${resolved}' is outside the sandbox directory '${ctx.sandbox_dir}'. Operation denied.`);
  }
}

export function createFilesystemTools(ctx: ToolContext): StructuredTool[] {
  return [
    tool(
      async ({ file_path, encoding, start_line, end_line }) => {
        const resolved = resolveSafe(ctx, file_path);
        guardPath(ctx, resolved);
        const content = await fs.readFile(resolved, encoding as BufferEncoding ?? 'utf8');
        const lines = content.split('\n');
        const sliced = (start_line || end_line)
          ? lines.slice((start_line ?? 1) - 1, end_line).join('\n')
          : content;
        return truncateOutput(sliced);
      },
      {
        name: 'read_file',
        description: 'Read the contents of a file. Optionally specify line range.',
        schema: z.object({
          file_path: z.string().describe('Path to the file (absolute or relative to working_dir)'),
          encoding: z.string().optional().describe('File encoding, default utf8'),
          start_line: z.number().int().positive().optional().describe('Start line (1-based)'),
          end_line: z.number().int().positive().optional().describe('End line (inclusive)'),
        }),
      }
    ),

    tool(
      async ({ file_path, content }) => {
        const resolved = resolveSafe(ctx, file_path);
        guardPath(ctx, resolved, true);
        await fs.ensureDir(path.dirname(resolved));
        await fs.writeFile(resolved, content, 'utf8');
        return JSON.stringify({ success: true, path: resolved });
      },
      {
        name: 'write_file',
        description: 'Write content to a file, creating it and parent directories if needed.',
        schema: z.object({
          file_path: z.string(),
          content: z.string().describe('Content to write'),
        }),
      }
    ),

    tool(
      async ({ file_path, content }) => {
        const resolved = resolveSafe(ctx, file_path);
        guardPath(ctx, resolved, true);
        await fs.ensureDir(path.dirname(resolved));
        await fs.appendFile(resolved, content, 'utf8');
        return JSON.stringify({ success: true, path: resolved });
      },
      {
        name: 'append_file',
        description: 'Append content to a file without overwriting existing content.',
        schema: z.object({
          file_path: z.string(),
          content: z.string(),
        }),
      }
    ),

    tool(
      async ({ file_path }) => {
        const resolved = resolveSafe(ctx, file_path);
        guardPath(ctx, resolved, true);
        await fs.remove(resolved);
        return JSON.stringify({ success: true, deleted: resolved });
      },
      {
        name: 'delete_file',
        description: 'Delete a file or directory.',
        schema: z.object({ file_path: z.string() }),
      }
    ),

    tool(
      async ({ source, destination }) => {
        const src = resolveSafe(ctx, source);
        const dest = resolveSafe(ctx, destination);
        guardPath(ctx, src, true);
        guardPath(ctx, dest, true);
        await fs.ensureDir(path.dirname(dest));
        await fs.move(src, dest, { overwrite: true });
        return JSON.stringify({ success: true, from: src, to: dest });
      },
      {
        name: 'move_file',
        description: 'Move or rename a file or directory.',
        schema: z.object({
          source: z.string(),
          destination: z.string(),
        }),
      }
    ),

    tool(
      async ({ source, destination }) => {
        const src = resolveSafe(ctx, source);
        const dest = resolveSafe(ctx, destination);
        guardPath(ctx, src);
        guardPath(ctx, dest, true);
        await fs.ensureDir(path.dirname(dest));
        await fs.copy(src, dest);
        return JSON.stringify({ success: true, from: src, to: dest });
      },
      {
        name: 'copy_file',
        description: 'Copy a file or directory to a new location.',
        schema: z.object({
          source: z.string(),
          destination: z.string(),
        }),
      }
    ),

    tool(
      async ({ dir_path, recursive, pattern }) => {
        const resolved = resolveSafe(ctx, dir_path ?? '.');
        guardPath(ctx, resolved);
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        let results = entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          path: path.join(resolved, e.name),
        }));

        if (pattern) {
          const re = new RegExp(pattern.replace('*', '.*').replace('?', '.'));
          results = results.filter(r => re.test(r.name));
        }

        if (recursive) {
          const subResults: typeof results = [];
          for (const entry of results.filter(r => r.type === 'dir')) {
            try {
              const subEntries = await fs.readdir(entry.path, { withFileTypes: true });
              subResults.push(...subEntries.map(e => ({
                name: e.name,
                type: e.isDirectory() ? 'dir' : 'file',
                path: path.join(entry.path, e.name),
              })));
            } catch { /* skip inaccessible */ }
          }
          results.push(...subResults);
        }

        return truncateOutput(JSON.stringify(results, null, 2));
      },
      {
        name: 'list_dir',
        description: 'List files and directories in a path.',
        schema: z.object({
          dir_path: z.string().optional().describe('Directory path, defaults to working_dir'),
          recursive: z.boolean().optional().describe('Include subdirectory contents'),
          pattern: z.string().optional().describe('Filter by name pattern (glob-like)'),
        }),
      }
    ),

    tool(
      async ({ dir_path }) => {
        const resolved = resolveSafe(ctx, dir_path);
        guardPath(ctx, resolved, true);
        await fs.ensureDir(resolved);
        return JSON.stringify({ success: true, path: resolved });
      },
      {
        name: 'create_dir',
        description: 'Create a directory and all parent directories.',
        schema: z.object({ dir_path: z.string() }),
      }
    ),

    tool(
      async ({ file_path }) => {
        const resolved = resolveSafe(ctx, file_path);
        guardPath(ctx, resolved);
        const stat = await fs.stat(resolved);
        return JSON.stringify({
          path: resolved,
          size: stat.size,
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          permissions: stat.mode.toString(8),
        });
      },
      {
        name: 'file_info',
        description: 'Get metadata about a file or directory (size, dates, permissions).',
        schema: z.object({ file_path: z.string() }),
      }
    ),

    tool(
      async ({ pattern, search_path, regex, case_insensitive, max_results }) => {
        const base = resolveSafe(ctx, search_path ?? '.');
        guardPath(ctx, base);
        const files = await glob('**/*', { cwd: base, nodir: true, absolute: true });
        const re = new RegExp(pattern, case_insensitive ? 'i' : undefined);
        const results: Array<{ file: string; line: number; match: string }> = [];

        for (const file of files) {
          if (results.length >= (max_results ?? 100)) break;
          try {
            const content = await fs.readFile(file, 'utf8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                results.push({ file: path.relative(base, file), line: i + 1, match: lines[i].trim() });
                if (results.length >= (max_results ?? 100)) break;
              }
            }
          } catch { /* skip binary/unreadable files */ }
        }

        return truncateOutput(JSON.stringify(results, null, 2));
      },
      {
        name: 'search_in_files',
        description: 'Search for a pattern (regex) inside file contents.',
        schema: z.object({
          pattern: z.string().describe('Regex pattern to search for'),
          search_path: z.string().optional().describe('Directory to search in, defaults to working_dir'),
          regex: z.boolean().optional().describe('Treat pattern as regex (default true)'),
          case_insensitive: z.boolean().optional(),
          max_results: z.number().int().positive().optional().describe('Max matches to return (default 100)'),
        }),
      }
    ),

    tool(
      async ({ pattern, search_path }) => {
        const base = resolveSafe(ctx, search_path ?? '.');
        guardPath(ctx, base);
        const files = await glob(pattern, { cwd: base, absolute: true });
        return truncateOutput(JSON.stringify(files.map(f => path.relative(base, f)), null, 2));
      },
      {
        name: 'find_files',
        description: 'Find files matching a glob pattern.',
        schema: z.object({
          pattern: z.string().describe('Glob pattern e.g. "**/*.ts", "src/**/*.json"'),
          search_path: z.string().optional().describe('Base directory, defaults to working_dir'),
        }),
      }
    ),
  ];
}

registerToolFactory(createFilesystemTools, 'filesystem');
