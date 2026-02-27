import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredTool } from '@langchain/core/tools';
import type { ToolContext } from '../types.js';
import { ShellAdapter } from '../adapters/shell.js';
import { registerToolFactory } from '../registry.js';
import { platform } from 'os';

export function createSystemTools(ctx: ToolContext): StructuredTool[] {
  const shell = ShellAdapter.create();
  const isWindows = platform() === 'win32';
  const isMac = platform() === 'darwin';

  return [
    tool(
      async ({ title, message, urgency }) => {
        try {
          if (isWindows) {
            const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null; $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $template.GetElementsByTagName('text')[0].AppendChild($template.CreateTextNode('${title}')); $template.GetElementsByTagName('text')[1].AppendChild($template.CreateTextNode('${message}')); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Smith').Show([Windows.UI.Notifications.ToastNotification]::new($template))`;
            await shell.run('powershell', ['-Command', ps], { cwd: ctx.working_dir, timeout_ms: 5_000 });
          } else if (isMac) {
            await shell.run('osascript', ['-e', `display notification "${message}" with title "${title}"`], {
              cwd: ctx.working_dir, timeout_ms: 5_000,
            });
          } else {
            const args = [title, message];
            if (urgency) args.unshift(`-u`, urgency);
            await shell.run('notify-send', args, { cwd: ctx.working_dir, timeout_ms: 5_000 });
          }
          return JSON.stringify({ success: true });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
      {
        name: 'notify',
        description: 'Send a desktop notification.',
        schema: z.object({
          title: z.string(),
          message: z.string(),
          urgency: z.enum(['low', 'normal', 'critical']).optional().describe('Linux urgency level'),
        }),
      }
    ),

    tool(
      async () => {
        try {
          let result;
          if (isWindows) {
            result = await shell.run('powershell', ['-Command', 'Get-Clipboard'], {
              cwd: ctx.working_dir, timeout_ms: 5_000,
            });
          } else if (isMac) {
            result = await shell.run('pbpaste', [], { cwd: ctx.working_dir, timeout_ms: 5_000 });
          } else {
            result = await shell.run('xclip', ['-selection', 'clipboard', '-o'], {
              cwd: ctx.working_dir, timeout_ms: 5_000,
            });
          }
          return JSON.stringify({ success: result.exitCode === 0, content: result.stdout });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
      {
        name: 'read_clipboard',
        description: 'Read the current clipboard contents.',
        schema: z.object({}),
      }
    ),

    tool(
      async ({ content }) => {
        try {
          let result;
          if (isWindows) {
            result = await shell.run('powershell', ['-Command', `Set-Clipboard -Value '${content.replace(/'/g, "''")}'`], {
              cwd: ctx.working_dir, timeout_ms: 5_000,
            });
          } else if (isMac) {
            result = await shell.run('sh', ['-c', `printf '%s' '${content.replace(/'/g, "'\\''")}' | pbcopy`], {
              cwd: ctx.working_dir, timeout_ms: 5_000,
            });
          } else {
            result = await shell.run('sh', ['-c', `printf '%s' '${content.replace(/'/g, "'\\''")}' | xclip -selection clipboard`], {
              cwd: ctx.working_dir, timeout_ms: 5_000,
            });
          }
          return JSON.stringify({ success: result.exitCode === 0 });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
      {
        name: 'write_clipboard',
        description: 'Write content to the clipboard.',
        schema: z.object({ content: z.string() }),
      }
    ),

    tool(
      async ({ url }) => {
        try {
          const open = isWindows ? 'start' : isMac ? 'open' : 'xdg-open';
          const result = await shell.run(isWindows ? 'cmd' : open, isWindows ? ['/c', 'start', url] : [url], {
            cwd: ctx.working_dir, timeout_ms: 5_000,
          });
          return JSON.stringify({ success: result.exitCode === 0, url });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
      {
        name: 'open_url',
        description: 'Open a URL in the default browser.',
        schema: z.object({ url: z.string() }),
      }
    ),

    tool(
      async ({ file_path }) => {
        try {
          const open = isWindows ? 'start' : isMac ? 'open' : 'xdg-open';
          const result = await shell.run(isWindows ? 'cmd' : open, isWindows ? ['/c', 'start', '""', file_path] : [file_path], {
            cwd: ctx.working_dir, timeout_ms: 5_000,
          });
          return JSON.stringify({ success: result.exitCode === 0, file_path });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
      {
        name: 'open_file',
        description: 'Open a file with the default application.',
        schema: z.object({ file_path: z.string() }),
      }
    ),
  ];
}

registerToolFactory(createSystemTools, 'system');
