import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import net from 'net';
import dns from 'dns';
import fs from 'fs-extra';
import path from 'path';
import type { StructuredTool } from '@langchain/core/tools';
import type { ToolContext } from '../types.js';
import { truncateOutput, isWithinDir } from '../utils.js';
import { registerToolFactory } from '../registry.js';

export function createNetworkTools(ctx: ToolContext): StructuredTool[] {
  return [
    tool(
      async ({ url, method, headers, body, timeout_ms }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout_ms ?? 30_000);

        try {
          const response = await fetch(url, {
            method: method ?? 'GET',
            headers: headers as Record<string, string> | undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          });

          const text = await response.text();
          return JSON.stringify({
            success: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            body: truncateOutput(text),
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        } finally {
          clearTimeout(timer);
        }
      },
      {
        name: 'http_request',
        description: 'Make an HTTP request (GET, POST, PUT, DELETE, PATCH).',
        schema: z.object({
          url: z.string().describe('Full URL to request'),
          method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional().describe('HTTP method, default GET'),
          headers: z.record(z.string(), z.string()).optional().describe('Request headers'),
          body: z.any().optional().describe('Request body (will be JSON-stringified)'),
          timeout_ms: z.number().optional().describe('Timeout in ms, default 30000'),
        }),
      }
    ),

    tool(
      async ({ host, port, timeout_ms }) => {
        const checkPort = port ?? 80;
        return new Promise((resolve) => {
          const socket = net.createConnection(checkPort, host);
          const timer = setTimeout(() => {
            socket.destroy();
            resolve(JSON.stringify({ success: false, host, port: checkPort, error: 'timeout' }));
          }, timeout_ms ?? 5_000);

          socket.on('connect', () => {
            clearTimeout(timer);
            socket.destroy();
            resolve(JSON.stringify({ success: true, host, port: checkPort, reachable: true }));
          });

          socket.on('error', (err) => {
            clearTimeout(timer);
            resolve(JSON.stringify({ success: false, host, port: checkPort, error: err.message }));
          });
        });
      },
      {
        name: 'ping',
        description: 'Preferred connectivity check tool. Verify if a host is reachable on a given port (TCP connect check). Use this instead of shell ping for routine reachability checks.',
        schema: z.object({
          host: z.string().describe('Hostname or IP'),
          port: z.number().int().optional().describe('Port to check, default 80'),
          timeout_ms: z.number().optional().describe('Timeout in ms, default 5000'),
        }),
      }
    ),

    tool(
      async ({ host, port, timeout_ms }) => {
        return new Promise((resolve) => {
          const socket = net.createConnection(port, host);
          const timer = setTimeout(() => {
            socket.destroy();
            resolve(JSON.stringify({ open: false, host, port, reason: 'timeout' }));
          }, timeout_ms ?? 5_000);

          socket.on('connect', () => {
            clearTimeout(timer);
            socket.destroy();
            resolve(JSON.stringify({ open: true, host, port }));
          });

          socket.on('error', (err) => {
            clearTimeout(timer);
            resolve(JSON.stringify({ open: false, host, port, reason: err.message }));
          });
        });
      },
      {
        name: 'port_check',
        description: 'Check if a specific port is open on a host.',
        schema: z.object({
          host: z.string(),
          port: z.number().int(),
          timeout_ms: z.number().optional(),
        }),
      }
    ),

    tool(
      async ({ hostname, record_type }) => {
        return new Promise((resolve) => {
          const rtype = (record_type ?? 'A') as 'A' | 'AAAA' | 'MX' | 'TXT' | 'CNAME';
          dns.resolve(hostname, rtype, (err, addresses) => {
            if (err) {
              resolve(JSON.stringify({ success: false, hostname, error: err.message }));
            } else {
              resolve(JSON.stringify({ success: true, hostname, type: record_type ?? 'A', addresses }));
            }
          });
        });
      },
      {
        name: 'dns_lookup',
        description: 'Resolve a hostname to IP addresses.',
        schema: z.object({
          hostname: z.string(),
          record_type: z.enum(['A', 'AAAA', 'MX', 'TXT', 'CNAME']).optional().describe('DNS record type, default A'),
        }),
      }
    ),

    tool(
      async ({ url, destination, timeout_ms }) => {
        const destPath = path.isAbsolute(destination)
          ? destination
          : path.resolve(ctx.working_dir, destination);

        // Enforce sandbox_dir on download destination
        if (ctx.sandbox_dir && !isWithinDir(destPath, ctx.sandbox_dir)) {
          return JSON.stringify({
            success: false,
            error: `Download destination '${destPath}' is outside the sandbox directory '${ctx.sandbox_dir}'. Operation denied.`,
          });
        }

        await fs.ensureDir(path.dirname(destPath));

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout_ms ?? 60_000);

        try {
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) {
            return JSON.stringify({ success: false, error: `HTTP ${response.status}: ${response.statusText}` });
          }

          const buffer = await response.arrayBuffer();
          await fs.writeFile(destPath, Buffer.from(buffer));

          return JSON.stringify({
            success: true,
            url,
            destination: destPath,
            size_bytes: buffer.byteLength,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        } finally {
          clearTimeout(timer);
        }
      },
      {
        name: 'download_file',
        description: 'Download a file from a URL to a local path.',
        schema: z.object({
          url: z.string().describe('URL to download from'),
          destination: z.string().describe('Local path to save the file'),
          timeout_ms: z.number().optional().describe('Timeout in ms, default 60000'),
        }),
      }
    ),
  ];
}

registerToolFactory(createNetworkTools, 'network');
