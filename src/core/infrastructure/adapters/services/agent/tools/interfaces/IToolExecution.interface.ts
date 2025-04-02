import { ITool, ToolExecutionContext } from './ITool.interface';

export const TOOL_EXECUTION_SERVICE_TOKEN = Symbol('ToolExecutionService');

export type ToolsExecutionResult = {
    results: string[];
    nameOfToolsExecuted: string[];
};

export interface IToolExecutionService {
    findTools(tools: string[]): ITool<any, any>[];
    processToolParams(toolParams: any, initialInput: any, runManager: any): any;
    bindToolsToModel(model: any, toolDefinitions: ITool<any, any>[]): any;
    prepareToolInvocationSequence(
        toolDefinitions: any,
        promptTemplate: any,
        context: ToolExecutionContext,
    );
    executeInvocationSequenceWithLLM(
        toolDefinitions: any,
        context: ToolExecutionContext,
    ): Promise<ToolsExecutionResult>;
    executeInvocationOnceWithTool(
        toolDefinition: string,
        context: ToolExecutionContext,
        params: any,
    );
}
