/**
 * Wire protocol types for Morpheus ↔ Smith communication.
 * All messages are JSON-serialized over WebSocket.
 *
 * NOTE: This is a standalone copy of src/runtime/smiths/types.ts from Morpheus.
 * Keep in sync when the protocol changes.
 */

// ─── Morpheus → Smith ───

export interface SmithTaskMessage {
  type: 'task';
  id: string;
  payload: {
    tool: string;
    args: Record<string, unknown>;
  };
}

export interface SmithPingMessage {
  type: 'ping';
  timestamp: number;
}

export interface SmithConfigQueryMessage {
  type: 'config_query';
}

export type MorpheusToSmithMessage =
  | SmithTaskMessage
  | SmithPingMessage
  | SmithConfigQueryMessage;

// ─── Smith → Morpheus ───

export interface SmithTaskResultMessage {
  type: 'task_result';
  id: string;
  result: {
    success: boolean;
    data: unknown;
    error?: string;
    duration_ms: number;
  };
}

export interface SmithTaskProgressMessage {
  type: 'task_progress';
  id: string;
  progress: {
    message: string;
    percent?: number;
  };
}

export interface SmithPongMessage {
  type: 'pong';
  stats: SmithSystemStats;
}

export interface SmithRegisterMessage {
  type: 'register';
  name: string;
  auth_token: string;
  capabilities: string[];
  protocol_version: number;
}

export interface SmithConfigReportMessage {
  type: 'config_report';
  devkit: {
    sandbox_dir: string;
    readonly_mode: boolean;
    enabled_categories: string[];
  };
}

export type SmithToMorpheusMessage =
  | SmithTaskResultMessage
  | SmithTaskProgressMessage
  | SmithPongMessage
  | SmithRegisterMessage
  | SmithConfigReportMessage;

// ─── Shared ───

export interface SmithSystemStats {
  cpu_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
  os: string;
  hostname: string;
  uptime_seconds: number;
}

export type SmithConnectionState = 'online' | 'offline' | 'connecting' | 'error';

export interface SmithInfo {
  name: string;
  host: string;
  port: number;
  state: SmithConnectionState;
  capabilities: string[];
  stats?: SmithSystemStats;
  lastSeen?: Date;
  error?: string;
}

export const SMITH_PROTOCOL_VERSION = 1;
export const SMITH_DEFAULT_PORT = 7900;
