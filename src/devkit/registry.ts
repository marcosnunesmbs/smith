import type { StructuredTool } from '@langchain/core/tools';
import type { ToolContext } from './types.js';

export type DevKitCategory = 'filesystem' | 'shell' | 'git' | 'network' | 'processes' | 'packages' | 'system' | 'browser';
export type DevKitToolFactory = (ctx: ToolContext) => StructuredTool[];

const factories: { category: DevKitCategory; factory: DevKitToolFactory }[] = [];

export function registerToolFactory(factory: DevKitToolFactory, category: DevKitCategory = 'system'): void {
  factories.push({ category, factory });
}

/** Categories that can be toggled off via DevKit config */
const TOGGLEABLE_CATEGORIES: Record<string, keyof ToolContext> = {
  filesystem: 'enable_filesystem',
  shell: 'enable_shell',
  git: 'enable_git',
  network: 'enable_network',
};

/**
 * Builds the full DevKit tool set for a given context.
 * Each factory receives the context (working_dir, allowed_commands, etc.)
 * and returns tools with the context captured in closure.
 * Disabled categories are filtered out based on context flags.
 */
export function buildDevKit(ctx: ToolContext): StructuredTool[] {
  return factories
    .filter(({ category }) => {
      const ctxKey = TOGGLEABLE_CATEGORIES[category];
      if (!ctxKey) return true; // non-toggleable categories always load
      return (ctx as any)[ctxKey] !== false;
    })
    .flatMap(({ factory }) => factory(ctx));
}
