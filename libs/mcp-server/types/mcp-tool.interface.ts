import { z } from 'zod';

type ZodShape = z.ZodRawShape;
type ZodObjectLike<S extends ZodShape = ZodShape> = z.ZodObject<S> | S;

export type McpToolAnnotations = {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    [k: string]: unknown;
};

/**
 * When an agent should offer the tool's action. Lives in the tool's `_meta`:
 * the SDK client parses `annotations` with a closed schema and drops any key
 * the spec does not define.
 */
export const PROACTIVE_HINT_META_KEY = 'io.kodus/proactiveHint';

export type McpToolMeta = {
    [PROACTIVE_HINT_META_KEY]?: string;
};

export interface McpToolDefinition<
    I extends ZodShape = ZodShape,
    O extends ZodShape = ZodShape,
> {
    name: string;
    description: string;
    inputSchema: ZodObjectLike<I>;
    outputSchema?: ZodObjectLike<O>;
    annotations?: McpToolAnnotations;
    _meta?: McpToolMeta;

    execute: (
        args: z.infer<z.ZodObject<I>>,
        extra?: any,
    ) => Promise<z.infer<z.ZodObject<O>>>;
}

export interface McpToolDefinitionTemplate<I extends ZodShape = ZodShape> {
    name: string;
    description: string;
    inputSchema: ZodObjectLike<I>;
}

export interface McpToolResult {
    content: Array<{ type: 'text'; text: string }>;
    _meta?: Record<string, unknown>;
}

export interface McpToolRegistry {
    getTools(): McpToolDefinition[];
    registerTool(tool: McpToolDefinition): void;
}

export const toShape = (x?: z.ZodObject<any> | z.ZodRawShape) => {
    if (!x) {
        return undefined;
    }

    return x instanceof z.ZodObject ? (x as z.ZodObject<any>).shape : x;
};

export interface BaseResponse {
    success: boolean;
    count?: number;
}
