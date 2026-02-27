export interface ToolContext {
  /** Working directory. Used as default CWD for shell/git operations. */
  working_dir: string;
  /** Allowlist for run_command. Empty array = no restriction. */
  allowed_commands: string[];
  /** project_id or session_id used for permission checks */
  permission_scope_id?: string;
  /** Default timeout in ms for shell operations */
  timeout_ms?: number;
  /** Sandbox root directory. When set, ALL file/shell/git paths are confined here. */
  sandbox_dir?: string;
  /** When true, blocks all write/delete/create operations. */
  readonly_mode?: boolean;
  /** Enable filesystem tools. Default: true. */
  enable_filesystem?: boolean;
  /** Enable shell tools. Default: true. */
  enable_shell?: boolean;
  /** Enable git tools. Default: true. */
  enable_git?: boolean;
  /** Enable network tools. Default: true. */
  enable_network?: boolean;
}

export interface ToolResult {
  success: boolean;
  output?: string;   // truncated to MAX_OUTPUT_BYTES
  error?: string;
  metadata?: Record<string, unknown>;
}

export const MAX_OUTPUT_BYTES = 50 * 1024; // 50 KB
