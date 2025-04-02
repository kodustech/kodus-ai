export const TOOL_MANAGER_SERVICE_TOKEN = Symbol('ToolManagerService');

export interface IToolManagerService {
    /**
     * Marks a tool as executed, storing the result of its execution.
     * @param toolName The name of the tool that was executed.
     * @param result The result of the tool's execution.
     */
    markAsExecuted(toolName: string, result: any): void;

    areRequirementsSatisfied(requirements: any): boolean;

    /**
     * Retrieves the previously stored result of an executed tool.
     * @param toolName The name of the tool whose result is desired.
     * @returns The result of the tool, if available.
     */
    getToolResults(toolNames: string[], type: string): Record<string, any>;
}
