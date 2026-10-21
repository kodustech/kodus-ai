/** Returned by BusinessRulesValidationAgentProvider when no task-management
 *  MCP is connected, so callers can detect it without importing the
 *  (Nest-injectable) provider class itself just to read a static field. */
export const NO_TASK_MCP_SENTINEL = '__NO_TASK_MCP__';
