/**
 * Smith WebSocket Server — accepts connections from Morpheus.
 *
 * - Validates auth token from handshake headers
 * - Handles task, ping, and config_query messages
 * - Returns task_result, pong, and config_report responses
 */
import https from 'https';
import fs from 'fs-extra';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { SMITH_PROTOCOL_VERSION } from './protocol/types.js';
import type {
  MorpheusToSmithMessage,
  SmithToMorpheusMessage,
  SmithTaskResultMessage,
  SmithTaskProgressMessage,
  SmithPongMessage,
  SmithRegisterMessage,
  SmithConfigReportMessage,
} from './protocol/types.js';
import type { SmithLocalConfig } from './config.js';
import { SmithExecutor } from './executor.js';
import { collectSystemStats } from './heartbeat.js';

export interface SmithServerOptions {
  config: SmithLocalConfig;
  executor: SmithExecutor;
  onLog?: (message: string, level: 'debug' | 'info' | 'warn' | 'error') => void;
}

const MAX_PAYLOAD_BYTES = 1 * 1024 * 1024; // 1 MB

export class SmithServer {
  private wss: WebSocketServer | null = null;
  private config: SmithLocalConfig;
  private executor: SmithExecutor;
  private log: (message: string, level: 'debug' | 'info' | 'warn' | 'error') => void;
  private clients = new Set<WebSocket>();
  private activeTasks = 0;
  private clientActivity = new Map<WebSocket, number>();
  private clientAddresses = new Map<WebSocket, string>();
  private idleInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: SmithServerOptions) {
    this.config = options.config;
    this.executor = options.executor;
    this.log = options.onLog ?? ((msg, level) => {
      const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
      if (level === 'error') console.error(`${prefix} ${msg}`);
      else if (level === 'warn') console.warn(`${prefix} ${msg}`);
      else console.log(`${prefix} ${msg}`);
    });
  }

  /** Start the WebSocket server */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const verifyClient = (info: { req: IncomingMessage }, callback: (res: boolean) => void) => {
        const valid = this.verifyAuth(info.req);
        if (!valid) {
          this.log(`Rejected connection: invalid auth from ${info.req.socket.remoteAddress}`, 'warn');
        }
        callback(valid);
      };

      const onListening = () => {
        const scheme = this.config.tls_cert && this.config.tls_key ? 'wss' : 'ws';
        this.log(`Smith '${this.config.name}' listening on ${scheme}://0.0.0.0:${this.config.port}`, 'info');

        if (this.config.idle_timeout_ms) {
          this.idleInterval = setInterval(() => {
            const now = Date.now();
            for (const [client, lastSeen] of this.clientActivity) {
              if (now - lastSeen > this.config.idle_timeout_ms!) {
                this.log(`Closing idle connection (no activity for ${this.config.idle_timeout_ms}ms)`, 'info');
                client.close(1000, 'Idle timeout');
              }
            }
          }, Math.min(this.config.idle_timeout_ms, 60000));
        }

        resolve();
      };

      if (this.config.tls_cert && this.config.tls_key) {
        const httpsServer = https.createServer({
          cert: fs.readFileSync(this.config.tls_cert),
          key: fs.readFileSync(this.config.tls_key),
        });
        this.wss = new WebSocketServer({ server: httpsServer, verifyClient });
        this.wss.on('error', (err) => {
          this.log(`WebSocket server error: ${err.message}`, 'error');
          reject(err);
        });
        this.wss.on('connection', (ws, req) => {
          this.handleConnection(ws, req);
        });
        httpsServer.listen(this.config.port, onListening);
      } else {
        this.wss = new WebSocketServer({
          port: this.config.port,
          verifyClient,
        });
        this.wss.on('listening', onListening);
        this.wss.on('error', (err) => {
          this.log(`WebSocket server error: ${err.message}`, 'error');
          reject(err);
        });
        this.wss.on('connection', (ws, req) => {
          this.handleConnection(ws, req);
        });
      }
    });
  }

  /** Stop the WebSocket server gracefully */
  async stop(): Promise<void> {
    if (!this.wss) return;

    if (this.idleInterval) {
      clearInterval(this.idleInterval);
      this.idleInterval = null;
    }

    // Close all client connections
    for (const client of this.clients) {
      try {
        client.close(1001, 'Smith shutting down');
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.clientActivity.clear();
    this.clientAddresses.clear();

    return new Promise((resolve) => {
      this.wss!.close(() => {
        this.wss = null;
        this.log('WebSocket server stopped', 'info');
        resolve();
      });
    });
  }

  /** Get number of connected clients */
  get connectionCount(): number {
    return this.clients.size;
  }

  /** Get number of tasks currently executing */
  get activeTaskCount(): number {
    return this.activeTasks;
  }

  // ─── Private ───

  private verifyAuth(req: IncomingMessage): boolean {
    const token = req.headers['x-smith-auth'] as string | undefined;
    const protocolVersion = req.headers['x-smith-protocol-version'] as string | undefined;

    if (!token || token !== this.config.auth_token) {
      return false;
    }

    if (protocolVersion && parseInt(protocolVersion, 10) !== SMITH_PROTOCOL_VERSION) {
      this.log(
        `Protocol version mismatch: expected ${SMITH_PROTOCOL_VERSION}, got ${protocolVersion}`,
        'warn'
      );
      return false;
    }

    return true;
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const remoteAddr = req.socket.remoteAddress ?? 'unknown';
    this.clients.add(ws);
    this.clientAddresses.set(ws, remoteAddr);
    this.clientActivity.set(ws, Date.now());
    this.log(`Morpheus connected from ${remoteAddr}`, 'info');

    // Send register message so Morpheus learns our capabilities
    const registerMsg: SmithRegisterMessage = {
      type: 'register',
      name: this.config.name,
      capabilities: this.executor.getCapabilities(),
      protocol_version: SMITH_PROTOCOL_VERSION,
    };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(registerMsg));
    }

    ws.on('message', async (data) => {
      this.clientActivity.set(ws, Date.now());
      try {
        const raw = data.toString();
        if (Buffer.byteLength(raw, 'utf8') > MAX_PAYLOAD_BYTES) {
          this.log(`Rejected oversized message (${Buffer.byteLength(raw, 'utf8')} bytes) from ${remoteAddr}`, 'warn');
          return;
        }
        const message = JSON.parse(raw) as MorpheusToSmithMessage;
        await this.handleMessage(ws, remoteAddr, message);
      } catch (err: any) {
        this.log(`Invalid message from Morpheus: ${err.message}`, 'warn');
      }
    });

    ws.on('close', (code, reason) => {
      this.clients.delete(ws);
      this.clientActivity.delete(ws);
      this.clientAddresses.delete(ws);
      this.log(`Morpheus disconnected (code: ${code})`, 'info');
    });

    ws.on('error', (err) => {
      this.log(`WebSocket client error: ${err.message}`, 'error');
    });
  }

  private async handleMessage(ws: WebSocket, remoteAddr: string, message: MorpheusToSmithMessage): Promise<void> {
    switch (message.type) {
      case 'task':
        await this.handleTask(ws, remoteAddr, message);
        break;

      case 'ping':
        this.handlePing(ws, message);
        break;

      case 'config_query':
        this.handleConfigQuery(ws);
        break;

      default:
        this.log(`Unknown message type: ${(message as any).type}`, 'warn');
    }
  }

  private async handleTask(
    ws: WebSocket,
    remoteAddr: string,
    message: Extract<MorpheusToSmithMessage, { type: 'task' }>
  ): Promise<void> {
    const { id, payload } = message;

    if (this.activeTasks >= this.config.max_concurrent_tasks) {
      this.log(`Task ${id} rejected: max_concurrent_tasks (${this.config.max_concurrent_tasks}) reached`, 'warn');
      const busyResponse: SmithTaskResultMessage = {
        type: 'task_result',
        id,
        result: {
          success: false,
          data: null,
          error: `Smith '${this.config.name}' is busy (max_concurrent_tasks=${this.config.max_concurrent_tasks} reached)`,
          duration_ms: 0,
        },
      };
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(busyResponse));
      }
      return;
    }

    this.log(`Executing task ${id}: ${payload.tool}`, 'debug');
    this.log(`[AUDIT] task_start id=${id} tool=${payload.tool} client=${remoteAddr}`, 'info');
    this.activeTasks++;

    // Send progress notification before executing
    const progress: SmithTaskProgressMessage = {
      type: 'task_progress',
      id,
      progress: {
        message: `Executing tool: ${payload.tool}`,
        percent: 0,
      },
    };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(progress));
    }

    let success = false;
    let duration_ms = 0;
    try {
      const result = await this.executor.execute(payload.tool, payload.args);
      success = result.success;
      duration_ms = result.duration_ms;

      const response: SmithTaskResultMessage = {
        type: 'task_result',
        id,
        result,
      };

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(response));
      }
    } catch (err: any) {
      const errorResponse: SmithTaskResultMessage = {
        type: 'task_result',
        id,
        result: {
          success: false,
          data: null,
          error: err.message ?? String(err),
          duration_ms: 0,
        },
      };

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(errorResponse));
      }
    } finally {
      this.activeTasks--;
      this.log(`[AUDIT] task_end id=${id} tool=${payload.tool} success=${success} duration=${duration_ms}ms`, 'info');
    }
  }

  private handlePing(
    ws: WebSocket,
    message: Extract<MorpheusToSmithMessage, { type: 'ping' }>
  ): void {
    const stats = collectSystemStats();
    const pong: SmithPongMessage = {
      type: 'pong',
      stats,
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(pong));
    }
  }

  private handleConfigQuery(ws: WebSocket): void {
    const report: SmithConfigReportMessage = {
      type: 'config_report',
      devkit: {
        sandbox_dir: this.config.sandbox_dir,
        readonly_mode: this.config.readonly_mode,
        enabled_categories: [
          ...(this.config.enable_filesystem ? ['filesystem'] : []),
          ...(this.config.enable_shell ? ['shell'] : []),
          ...(this.config.enable_git ? ['git'] : []),
          ...(this.config.enable_network ? ['network'] : []),
          'processes',
          'packages',
          'system',
        ],
      },
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(report));
    }
  }
}
