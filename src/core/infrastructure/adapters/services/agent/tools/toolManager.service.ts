import { Injectable } from '@nestjs/common';
import { IToolManagerService } from './interfaces/IToolManager.interface';

@Injectable()
export class ToolManagerService implements IToolManagerService {
    private executedTools: Map<string, any> = new Map();

    constructor() {}
    getToolResults(toolNames: string[], type?: string): Record<string, any> {
        return toolNames.reduce(
            (results, toolName) => {
                // Retrieves the tool's result from the map of executed tools.
                // If the tool has not been executed, returns null (or another value as needed).
                const result = this.executedTools.get(toolName) ?? null;

                // Adds the result to the results object, using the tool name as the key.
                if (type && result?.[type]) {
                    results[toolName] = result?.[type];
                } else if (!type) {
                    results[toolName] = result;
                }

                return results;
            },
            {} as Record<string, any>,
        );
    }

    markAsExecuted(toolName: string, result: any): void {
        this.executedTools.set(toolName, result);
    }

    areRequirementsSatisfied(requirements: any): boolean {
        return requirements.every((dep) => this.executedTools.has(dep));
    }
}
