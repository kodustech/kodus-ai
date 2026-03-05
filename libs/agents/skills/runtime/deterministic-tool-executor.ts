export interface DeterministicToolCallResponse {
    result?: unknown;
}

export type DeterministicFallbackReason =
    | 'tool_unavailable'
    | 'precondition_failed'
    | 'missing_result'
    | 'execution_error';

export interface ExecuteDeterministicToolParams<TOutput> {
    toolName: string | undefined;
    args: Record<string, unknown>;
    callTool: (
        toolName: string,
        args: Record<string, unknown>,
    ) => Promise<DeterministicToolCallResponse>;
    extract: (payload: unknown) => TOutput;
    fallback: TOutput;
    validate?: () => DeterministicFallbackReason | undefined;
    onError?: 'throw' | 'fallback';
    onFallback?: (reason: DeterministicFallbackReason, error?: unknown) => void;
}

/**
 * Shared deterministic MCP tool execution helper.
 * Returns fallback when tool is unavailable or preconditions fail.
 */
export async function executeDeterministicTool<TOutput>(
    params: ExecuteDeterministicToolParams<TOutput>,
): Promise<TOutput> {
    const toolName = params.toolName;
    if (!toolName?.trim()) {
        params.onFallback?.('tool_unavailable');
        return params.fallback;
    }

    const validationError = params.validate?.();
    if (validationError) {
        params.onFallback?.(validationError);
        return params.fallback;
    }

    try {
        const toolResult = await params.callTool(toolName, params.args);
        if (toolResult.result === undefined) {
            params.onFallback?.('missing_result');
            return params.fallback;
        }
        return params.extract(toolResult.result);
    } catch (error) {
        if (params.onError === 'fallback') {
            params.onFallback?.('execution_error', error);
            return params.fallback;
        }
        throw error;
    }
}
