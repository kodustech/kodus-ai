import type { Response } from 'express';

export const MCP_EXPOSED_HEADERS = [
    'Mcp-Session-Id',
    'Mcp-Protocol-Version',
    'Last-Event-ID',
] as const;

function normalizeOrigin(value: string | undefined | null): string | null {
    if (!value) {
        return null;
    }

    try {
        return new URL(value).origin;
    } catch {
        return null;
    }
}

export function applyMcpHttpResponseHeaders(
    response: Pick<Response, 'setHeader'>,
): void {
    response.setHeader(
        'Access-Control-Expose-Headers',
        MCP_EXPOSED_HEADERS.join(', '),
    );
}

export function isAllowedMcpOrigin(params: {
    origin?: string;
    requestOrigin?: string;
}): boolean {
    const normalizedOrigin = normalizeOrigin(params.origin);

    if (!normalizedOrigin) {
        return params.origin === undefined;
    }

    const normalizedRequestOrigin = normalizeOrigin(params.requestOrigin);

    if (
        normalizedRequestOrigin &&
        normalizedOrigin === normalizedRequestOrigin
    ) {
        return true;
    }

    return false;
}
