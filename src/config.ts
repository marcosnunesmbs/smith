/**
 * Smith local configuration.
 * Loaded from ~/.smith/config.yaml (or SMITH_CONFIG_PATH env var).
 */
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { z } from 'zod';

// ─── Schema ───

export const SmithLocalConfigSchema = z.object({
  /** Unique name for this Smith instance */
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/),
  /** Port for the WebSocket server (default: 7900) */
  port: z.number().min(1).max(65535).default(7900),
  /** Auth token that Morpheus must present to connect */
  auth_token: z.string().min(1),
  /** Sandbox directory — all tool operations are confined here */
  sandbox_dir: z.string().default(process.cwd()),
  /** Block destructive operations when true */
  readonly_mode: z.boolean().default(false),
  /** Enable filesystem tools */
  enable_filesystem: z.boolean().default(true),
  /** Enable shell tools */
  enable_shell: z.boolean().default(true),
  /** Enable git tools */
  enable_git: z.boolean().default(true),
  /** Enable network tools */
  enable_network: z.boolean().default(true),
  /** Shell command allowlist (empty = allow all) */
  allowed_shell_commands: z.array(z.string()).default([]),
  /** Tool execution timeout in ms */
  timeout_ms: z.number().min(1000).default(30000),
  /** Log level */
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type SmithLocalConfig = z.infer<typeof SmithLocalConfigSchema>;

// ─── Paths ───

const SMITH_HOME = process.env.SMITH_HOME ?? path.join(os.homedir(), '.smith');
const CONFIG_FILE = process.env.SMITH_CONFIG_PATH ?? path.join(SMITH_HOME, 'config.yaml');
const PID_FILE = path.join(SMITH_HOME, 'smith.pid');

export const SMITH_PATHS = {
  home: SMITH_HOME,
  config: CONFIG_FILE,
  pid: PID_FILE,
  logs: path.join(SMITH_HOME, 'logs'),
};

// ─── Loader ───

let cachedConfig: SmithLocalConfig | null = null;

export function loadConfig(): SmithLocalConfig {
  if (cachedConfig) return cachedConfig;

  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(
      `Smith config not found at ${CONFIG_FILE}.\n` +
      `Run 'smith init' to create a default config, or set SMITH_CONFIG_PATH.`
    );
  }

  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  const parsed = yaml.load(raw) as Record<string, unknown>;
  const result = SmithLocalConfigSchema.parse(parsed);
  cachedConfig = result;
  return result;
}

export function getConfig(): SmithLocalConfig {
  if (!cachedConfig) return loadConfig();
  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

/** Generate a default config.yaml content */
export function generateDefaultConfig(name: string, authToken: string): string {
  return `# Smith Agent Configuration
name: ${name}
port: 7900
auth_token: "${authToken}"

# Sandbox — confine all operations to this directory
sandbox_dir: "${process.cwd().replace(/\\/g, '/')}"

# Security
readonly_mode: false
enable_filesystem: true
enable_shell: true
enable_git: true
enable_network: true
allowed_shell_commands: []

# Timeouts
timeout_ms: 30000

# Logging
log_level: info
`;
}
