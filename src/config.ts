/**
 * Smith local configuration.
 * Loaded from ~/.smith/config.yaml (or SMITH_CONFIG_PATH env var).
 */
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { z } from 'zod';
import { randomUUID } from 'crypto';

// ─── Schema ───

export const SmithLocalConfigSchema = z.object({
  /** Unique name for this Smith instance */
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/),
  /** Port for the WebSocket server (default: 7900) */
  port: z.number().min(1).max(65535).default(7900),
  /** Auth token that Morpheus must present to connect (auto-generated and persisted if omitted) */
  auth_token: z.string().min(1).optional(),
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

export type SmithLocalConfig = z.infer<typeof SmithLocalConfigSchema> & { auth_token: string };

// ─── Paths ───

const SMITH_HOME = process.env.SMITH_HOME ?? path.join(os.homedir(), '.smith');
const CONFIG_FILE = process.env.SMITH_CONFIG_PATH ?? path.join(SMITH_HOME, 'config.yaml');
const PID_FILE = path.join(SMITH_HOME, 'smith.pid');

const AUTH_TOKEN_FILE = path.join(SMITH_HOME, 'auth_token');

export const SMITH_PATHS = {
  home: SMITH_HOME,
  config: CONFIG_FILE,
  pid: PID_FILE,
  logs: path.join(SMITH_HOME, 'logs'),
  authToken: AUTH_TOKEN_FILE,
};

// ─── Environment variable helpers ───

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return undefined;
}

/**
 * Build a config object from SMITH_* environment variables.
 * Returns only the keys that have corresponding env vars set.
 */
function configFromEnv(): Record<string, unknown> {
  const env: Record<string, unknown> = {};

  if (process.env.SMITH_NAME) env.name = process.env.SMITH_NAME;
  if (process.env.SMITH_PORT) env.port = parseInt(process.env.SMITH_PORT, 10);
  if (process.env.SMITH_AUTH_TOKEN) env.auth_token = process.env.SMITH_AUTH_TOKEN;
  if (process.env.SMITH_SANDBOX_DIR) env.sandbox_dir = process.env.SMITH_SANDBOX_DIR;
  if (process.env.SMITH_READONLY_MODE !== undefined) env.readonly_mode = parseBool(process.env.SMITH_READONLY_MODE);
  if (process.env.SMITH_ENABLE_FILESYSTEM !== undefined) env.enable_filesystem = parseBool(process.env.SMITH_ENABLE_FILESYSTEM);
  if (process.env.SMITH_ENABLE_SHELL !== undefined) env.enable_shell = parseBool(process.env.SMITH_ENABLE_SHELL);
  if (process.env.SMITH_ENABLE_GIT !== undefined) env.enable_git = parseBool(process.env.SMITH_ENABLE_GIT);
  if (process.env.SMITH_ENABLE_NETWORK !== undefined) env.enable_network = parseBool(process.env.SMITH_ENABLE_NETWORK);
  if (process.env.SMITH_ALLOWED_SHELL_COMMANDS) env.allowed_shell_commands = process.env.SMITH_ALLOWED_SHELL_COMMANDS.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.SMITH_TIMEOUT_MS) env.timeout_ms = parseInt(process.env.SMITH_TIMEOUT_MS, 10);
  if (process.env.SMITH_LOG_LEVEL) env.log_level = process.env.SMITH_LOG_LEVEL;

  return env;
}

// ─── Loader ───

let cachedConfig: SmithLocalConfig | null = null;

/**
 * Load config with layered resolution:
 *   1. config.yaml (base, if it exists)
 *   2. SMITH_* env vars (override)
 *
 * If no config.yaml exists, config is built entirely from env vars.
 * At minimum, `SMITH_NAME` (or its yaml equivalent) must be provided.
 * `auth_token` is auto-generated if not provided from any source.
 */
export function loadConfig(): SmithLocalConfig {
  if (cachedConfig) return cachedConfig;

  let fileConfig: Record<string, unknown> = {};

  if (fs.existsSync(CONFIG_FILE)) {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    fileConfig = (yaml.load(raw) as Record<string, unknown>) ?? {};
  }

  const envConfig = configFromEnv();
  const merged = { ...fileConfig, ...envConfig };

  // Require at least name from some source
  if (!merged.name) {
    throw new Error(
      `Smith config not found at ${CONFIG_FILE} and SMITH_NAME env var is not set.\n` +
      `Either run 'smith init' to create a config, or provide configuration via environment variables.`
    );
  }

  const result = SmithLocalConfigSchema.parse(merged);

  // Resolve auth_token: explicit > persisted file > auto-generate & persist
  if (!result.auth_token) {
    let token: string | undefined;

    // Try to read a previously persisted token
    if (fs.existsSync(AUTH_TOKEN_FILE)) {
      token = fs.readFileSync(AUTH_TOKEN_FILE, 'utf-8').trim();
    }

    // Generate and persist a new one
    if (!token) {
      token = randomUUID();
      fs.ensureDirSync(SMITH_HOME);
      fs.writeFileSync(AUTH_TOKEN_FILE, token, 'utf-8');
    }

    (result as any).auth_token = token;
  }

  cachedConfig = result as SmithLocalConfig;
  return cachedConfig;
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
