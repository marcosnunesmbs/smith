/**
 * Smith Executor — receives tool payloads from Morpheus and runs DevKit tools locally.
 *
 * Builds the tool set from the DevKit registry using the Smith's local config
 * (sandbox, security, etc.), then dispatches incoming task payloads to the matching tool.
 */
import type { StructuredTool } from '@langchain/core/tools';
import { buildDevKit } from './devkit/index.js';
import type { ToolContext } from './devkit/types.js';
import type { SmithLocalConfig } from './config.js';

export class SmithExecutor {
  private tools: Map<string, StructuredTool> = new Map();
  private capabilities: string[] = [];

  constructor(private config: SmithLocalConfig) {}

  /** Initialize — build all DevKit tools based on local config */
  async initialize(): Promise<void> {
    const ctx: ToolContext = {
      working_dir: this.config.sandbox_dir,
      allowed_commands: this.config.allowed_shell_commands,
      timeout_ms: this.config.timeout_ms,
      sandbox_dir: this.config.sandbox_dir,
      readonly_mode: this.config.readonly_mode,
      enable_filesystem: this.config.enable_filesystem,
      enable_shell: this.config.enable_shell,
      enable_git: this.config.enable_git,
      enable_network: this.config.enable_network,
    };

    const toolList = buildDevKit(ctx);
    this.tools.clear();
    this.capabilities = [];

    for (const tool of toolList) {
      this.tools.set(tool.name, tool);
      this.capabilities.push(tool.name);
    }
  }

  /** Get list of available tool names (capabilities) */
  getCapabilities(): string[] {
    return [...this.capabilities];
  }

  /** Execute a tool by name with the given arguments */
  async execute(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ success: boolean; data: unknown; error?: string; duration_ms: number }> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        data: null,
        error: `Unknown tool: '${toolName}'. Available: [${this.capabilities.join(', ')}]`,
        duration_ms: 0,
      };
    }

    const start = Date.now();
    try {
      const result = await tool.invoke(args);
      const duration_ms = Date.now() - start;

      // DevKit tools return JSON strings
      let parsed: unknown = result;
      if (typeof result === 'string') {
        try {
          parsed = JSON.parse(result);
        } catch {
          parsed = result;
        }
      }

      // Check if the tool itself reported failure
      const isToolError =
        typeof parsed === 'object' &&
        parsed !== null &&
        'success' in parsed &&
        (parsed as any).success === false;

      return {
        success: !isToolError,
        data: parsed,
        error: isToolError ? (parsed as any).error : undefined,
        duration_ms,
      };
    } catch (err: any) {
      return {
        success: false,
        data: null,
        error: err.message ?? String(err),
        duration_ms: Date.now() - start,
      };
    }
  }
}
