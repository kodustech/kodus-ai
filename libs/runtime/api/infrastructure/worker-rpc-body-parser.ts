import * as bodyParser from 'body-parser';
import type { ErrorRequestHandler, RequestHandler } from 'express';

import { MODEL_TURN_LIMITS } from '@libs/runtime/contracts/model-turn';
import { PLANNER_SOURCE_LIMITS } from '@libs/runtime/contracts/planner-source';
import { parseStrictJson } from '@libs/runtime/protocol/strict-json';

/** Install before the product parser, which otherwise discards duplicate keys. */
function boundedWorkerJsonParser(
    bytes: number,
): [RequestHandler, RequestHandler, ErrorRequestHandler] {
    const media: RequestHandler = (req, res, next) => {
        if (!req.is('application/json')) {
            res.status(415).json({ error: 'unsupported_media_type' });
            return;
        }
        next();
    };
    const parse = bodyParser.json({
        limit: bytes,
        type: 'application/json',
        inflate: false,
        verify: (_req, _res, body) => {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
            parseStrictJson(text, 32);
        },
    });
    const refuse: ErrorRequestHandler = (error, _req, res, _next) => {
        // Parser errors can retain raw prompts or source: never forward them.
        const large = error?.type === 'entity.too.large';
        res.status(large ? 413 : 400).json({
            error: large ? 'request_too_large' : 'invalid_request',
        });
    };
    return [media, parse, refuse];
}

export function runtimeModelTurnJsonParser(): [
    RequestHandler,
    RequestHandler,
    ErrorRequestHandler,
] {
    return boundedWorkerJsonParser(MODEL_TURN_LIMITS.requestBytes);
}

export function runtimePlannerSourceJsonParser(): [
    RequestHandler,
    RequestHandler,
    ErrorRequestHandler,
] {
    return boundedWorkerJsonParser(PLANNER_SOURCE_LIMITS.bytes);
}
