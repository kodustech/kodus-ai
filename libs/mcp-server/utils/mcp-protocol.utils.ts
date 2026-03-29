import { SimpleLogger } from '@kodus/flow/dist/observability/logger';
import { z } from 'zod';

import { JsonRpcCode } from './errors'; // ← novo
import { toJsonRpcError, toToolErrorPayload } from './serialize'; // ← novo

type TextBlock = { type: 'text'; text: string };
type ResourceLink = {
    type: 'resource_link';
    uri: string;
    name?: string;
    description?: string;
    mimeType?: string;
};

type ToolResult = {
    content: Array<TextBlock | ResourceLink>;
    structuredContent?: any;
    isError?: true;
};

type JsonRpcError = {
    jsonrpc: '2.0';
    id: string | number | null;
    error: { code: number; message: string; data?: any };
};

export function createToolResponse<T>(
    data: T,
    opts?: {
        summary?: string; // primeira linha humana
        includeJsonText?: boolean; // default true
        resources?: Array<{
            uri: string;
            name?: string;
            description?: string;
            mimeType?: string;
        }>;
        error?: boolean;
    },
): ToolResult {
    const {
        includeJsonText = true,
        resources = [],
        error = false,
    } = opts ?? {};
    const content: ToolResult['content'] = [];

    if (includeJsonText) {
        content.push({
            type: 'text',
            text: typeof data === 'string' ? data : JSON.stringify(data),
        });
    }
    for (const r of resources) {
        content.push({ type: 'resource_link', ...r });
    }

    return error
        ? { content, isError: true }
        : {
              content,
              structuredContent:
                  typeof data === 'string' ? { value: data } : data,
          };
}

export function wrapToolHandler<I = any, O = any>(
    handler: (args: I, extra?: any) => Promise<O>,
    toolName?: string,
    onErrorStructured?: (e: any, args: I) => any,
    logger?: SimpleLogger,
) {
    return async (args: I, extra?: any) => {
        const start = Date.now();
        try {
            const result = await handler(args, extra);
            const res = createToolResponse(result);

            if (logger && toolName) {
                logger.log({
                    message: 'MCP tool completed',
                    context: 'McpProtocol',
                    metadata: { tool: toolName, duration: Date.now() - start },
                });
            }

            return res;
        } catch (e: any) {
            const payload = toToolErrorPayload(e);
            const duration = Date.now() - start;
            const err = Object.assign(new Error(payload.message), {
                name: payload.name,
                code: payload.code,
                data: payload.data,
            });
            if (logger && toolName) {
                logger.error({
                    message: 'MCP tool failed',
                    context: 'McpProtocol',
                    error: err,
                    metadata: { tool: toolName, duration },
                });
            }

            if (onErrorStructured) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(payload),
                        },
                    ],
                    structuredContent: onErrorStructured(e, args),
                    isError: true,
                };
            }

            return createToolResponse(payload, {
                error: true,
                summary: `Tool error: ${payload.message}`,
            });
        }
    };
}

export function createErrorResponse(
    code: number,
    message: string,
    data: any = null,
): never {
    const err: JsonRpcError = toJsonRpcError({ code, message, data }, null);
    throw err;
}

export const ErrorCodes = {
    PARSE_ERROR: JsonRpcCode.PARSE_ERROR,
    INVALID_REQUEST: JsonRpcCode.INVALID_REQUEST,
    METHOD_NOT_FOUND: JsonRpcCode.METHOD_NOT_FOUND,
    INVALID_PARAMS: JsonRpcCode.INVALID_PARAMS,
    INTERNAL_ERROR: JsonRpcCode.INTERNAL_ERROR,
    RESOURCE_NOT_FOUND: JsonRpcCode.NOT_FOUND,
    RESOURCE_ACCESS_DENIED: JsonRpcCode.ACCESS_DENIED,
    RESOURCE_UNAVAILABLE: JsonRpcCode.SERVER_ERROR,
    BACKEND_ERROR: JsonRpcCode.BACKEND_ERROR,
} as const;

export function validateArgs<T>(
    args: any,
    schema:
        | z.ZodType<T>
        | {
              parse?: (a: any) => T;
              validate?: (a: any) => {
                  success: boolean;
                  data?: T;
                  error?: any;
              };
          },
): T {
    try {
        if (
            schema &&
            'parse' in schema &&
            typeof (schema as any).parse === 'function'
        ) {
            return (schema as any).parse(args);
        }
        if (
            schema &&
            'validate' in schema &&
            typeof (schema as any).validate === 'function'
        ) {
            const r = (schema as any).validate(args);
            if (!r?.success)
                throw Object.assign(
                    new Error(r?.error || 'Invalid parameters'),
                    { code: JsonRpcCode.INVALID_PARAMS },
                );
            return r.data as T;
        }
        return args;
    } catch (error: any) {
        throw Object.assign(error, { code: JsonRpcCode.INVALID_PARAMS });
    }
}

export function logToolInvocation(
    toolName: string,
    args: any,
    extra: any,
    logger: SimpleLogger,
): number {
    logger.log({
        message: 'MCP tool invoked',
        context: 'McpProtocol',
        metadata: {
            tool: toolName,
            args:
                args && typeof args === 'object' && Object.keys(args).length
                    ? args
                    : undefined,
            requestId: extra?.requestId,
        },
    });
    return Date.now();
}

export function logToolCompletion(
    toolName: string,
    startTime: number,
    logger: SimpleLogger,
    error?: any,
): void {
    const duration = Date.now() - startTime;
    if (error) {
        logger.error({
            message: 'MCP tool failed',
            context: 'McpProtocol',
            error,
            metadata: { tool: toolName, duration },
        });
    } else {
        logger.log({
            message: 'MCP tool completed',
            context: 'McpProtocol',
            metadata: { tool: toolName, duration },
        });
    }
}

export async function executeLoggedTool<I = any, O = any>(
    toolName: string,
    executor: (args: I, extra?: any) => Promise<O>,
    args: I,
    extra: any,
    logger: SimpleLogger,
): Promise<O> {
    const startTime = Date.now();

    logger.log({
        message: 'MCP tool invoked',
        context: 'McpProtocol',
        metadata: {
            tool: toolName,
            organizationId: (args as any)?.organizationId,
            teamId: (args as any)?.teamId,
            requestId: extra?.requestId,
        },
    });

    try {
        const result = await executor(args, extra);
        logToolCompletion(toolName, startTime, logger);
        return result;
    } catch (error) {
        logToolCompletion(toolName, startTime, logger, error);
        throw error;
    }
}

export function extractMcpRequestMetadata(body: any): {
    jsonrpcMethod?: string;
    toolName?: string;
    organizationId?: string;
    teamId?: string;
    requestId?: string;
} {
    const params = body?.params;
    const args = params?.arguments;

    return {
        jsonrpcMethod:
            typeof body?.method === 'string' ? body.method : undefined,
        toolName:
            typeof params?.name === 'string'
                ? params.name
                : typeof args?.toolName === 'string'
                  ? args.toolName
                  : undefined,
        organizationId:
            typeof args?.organizationId === 'string'
                ? args.organizationId
                : undefined,
        teamId: typeof args?.teamId === 'string' ? args.teamId : undefined,
        requestId:
            typeof params?.requestId === 'string'
                ? params.requestId
                : typeof args?.requestId === 'string'
                  ? args.requestId
                  : undefined,
    };
}
