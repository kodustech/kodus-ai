import { HttpStatus } from '@nestjs/common';
import { SimpleLogger } from '@kodus/flow/dist/observability/logger';
import { Response } from 'express';

import { applyMcpHttpResponseHeaders } from '../utils/mcp-http.config';
import { JsonRpcCode } from '../utils/errors';
import { extractMcpRequestMetadata } from '../utils/mcp-protocol.utils';
import { toJsonRpcError } from '../utils/serialize';

function getJsonRpcId(body: any): string | number | null {
    return body && (typeof body.id === 'string' || typeof body.id === 'number')
        ? body.id
        : null;
}

type HandleStatelessMcpPostParams = {
    body: any;
    res: Response;
    handler: (body: any, res: Response) => Promise<void>;
    errorContext: string;
    errorMessage: string;
    logger: SimpleLogger;
};

export async function handleStatelessMcpPost({
    body,
    res,
    handler,
    errorContext,
    errorMessage,
    logger,
}: HandleStatelessMcpPostParams) {
    try {
        applyMcpHttpResponseHeaders(res);
        await handler(body, res);
        return;
    } catch (error) {
        const id = getJsonRpcId(body);
        logger.error({
            message: errorMessage,
            context: errorContext,
            error,
            metadata: extractMcpRequestMetadata(body),
        });

        if (res.headersSent) {
            return;
        }

        return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(
            toJsonRpcError(
                {
                    code: JsonRpcCode.INTERNAL_ERROR,
                    message: 'Internal error',
                    data: { reason: 'controller-failure' },
                },
                id,
            ),
        );
    }
}

export function handleUnsupportedStatelessMcpMethod(res: Response) {
    applyMcpHttpResponseHeaders(res);
    res.setHeader('Allow', 'POST');
    return res.status(HttpStatus.METHOD_NOT_ALLOWED).json(
        toJsonRpcError(
            {
                code: JsonRpcCode.SERVER_ERROR,
                message: 'Method not allowed.',
            },
            null,
        ),
    );
}
