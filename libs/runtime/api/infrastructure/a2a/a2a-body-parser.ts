import * as bodyParser from 'body-parser';
import type { ErrorRequestHandler, RequestHandler } from 'express';

import { EXTERNAL_FINDING_LIMITS } from '@libs/runtime/contracts/external-findings';
import { parseStrictJson } from '@libs/runtime/protocol/strict-json';

/** Install before the product parser: bound bytes before parsing, reject ambiguous JSON. */
export function runtimeA2AJsonParser(): [
    RequestHandler,
    RequestHandler,
    ErrorRequestHandler,
] {
    const media: RequestHandler = (req, res, next) => {
        if (!req.is(['application/json', 'application/a2a+json'])) {
            res.status(415).json({ error: 'unsupported_media_type' });
            return;
        }
        next();
    };
    const parse = bodyParser.json({
        limit: EXTERNAL_FINDING_LIMITS.bodyBytes,
        type: ['application/json', 'application/a2a+json'],
        verify: (_req, _res, bytes) => {
            parseStrictJson(bytes.toString('utf8'), 32);
        },
    });
    const refuse: ErrorRequestHandler = (error, _req, res, _next) => {
        // Body-parser errors can carry the untrusted body; never forward or log them.
        const large = error?.type === 'entity.too.large';
        res.status(large ? 413 : 400).json({
            error: large ? 'request_too_large' : 'invalid_request',
        });
    };
    return [media, parse, refuse];
}
