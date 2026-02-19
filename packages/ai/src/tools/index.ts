export const toolRegistry = new Map<string, unknown>();

export function registerTool(name: string, tool: unknown): void {
  toolRegistry.set(name, tool);
}

export function getTool(name: string): unknown | undefined {
  return toolRegistry.get(name);
}

export function listTools(): string[] {
  return Array.from(toolRegistry.keys());
}
