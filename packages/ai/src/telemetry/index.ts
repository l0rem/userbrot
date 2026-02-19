export function logGraphStep(
  nodeName: string,
  durationMs: number,
  metadata?: Record<string, unknown>
): void {
  console.log(`[LangGraph] ${nodeName} completed in ${durationMs}ms`, metadata ?? "");
}

export function logGraphError(
  nodeName: string,
  error: Error
): void {
  console.error(`[LangGraph] ${nodeName} failed:`, error);
}
