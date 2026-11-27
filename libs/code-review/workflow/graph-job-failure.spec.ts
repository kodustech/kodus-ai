import { execFileSync } from 'child_process';
import path from 'path';

import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { QueryFailedError } from 'typeorm';

import { classifyGraphJobError } from './graph-job-failure';

// Jest maps the `e2b` package name to a stub. Build the error in a plain
// Node process so the assertion sees the SDK class handleApiError throws.
function sdkSandboxError(message: string): Error {
    const stdout = execFileSync(
        process.execPath,
        [
            '-e',
            'const { SandboxError } = require("e2b");' +
                'const error = new SandboxError(process.env.SANDBOX_MESSAGE);' +
                'const own = {};' +
                'for (const key of Object.getOwnPropertyNames(error)) {' +
                '  if (key !== "stack") own[key] = error[key];' +
                '}' +
                'process.stdout.write(JSON.stringify({ own }));',
        ],
        {
            cwd: path.resolve(__dirname, '../../..'),
            encoding: 'utf8',
            env: { ...process.env, SANDBOX_MESSAGE: message },
        },
    );
    const payload = JSON.parse(stdout) as {
        own: Record<string, unknown>;
    };
    const error = new Error(String(payload.own.message));
    Object.assign(error, payload.own);
    return error;
}

function queryFailed(code: string, message = 'database error') {
    const driver = Object.assign(new Error(message), { code });
    return new QueryFailedError('SELECT 1', [], driver);
}

it.each([
    [
        new AggregateError([{ code: 'ENETUNREACH' }, { code: 'ETIMEDOUT' }]),
        ErrorClassification.RETRYABLE,
    ],
    [
        { lastError: { cause: { statusCode: 429 } } },
        ErrorClassification.RETRYABLE,
    ],
    [
        {
            code: 'ECONNRESET',
            errors: [{ cause: { response: { status: 403 } } }],
        },
        ErrorClassification.PERMANENT,
    ],
    [
        { lastError: { status: 400 }, errors: [{ status: 503 }] },
        ErrorClassification.PERMANENT,
    ],
    [
        {
            lastError: { cause: { code: 'ECONNRESET' } },
            errors: [{ response: { status: 403 } }],
        },
        ErrorClassification.RETRYABLE,
    ],
    [
        {
            lastError: { name: 'TimeoutError' },
            cause: { status: 400 },
        },
        ErrorClassification.RETRYABLE,
    ],
    [
        {
            lastError: new SyntaxError('invalid graph'),
            errors: [{ status: 503 }],
        },
        ErrorClassification.PERMANENT,
    ],
    [
        { lastError: null, errors: [{ response: { status: 503 } }] },
        ErrorClassification.RETRYABLE,
    ],
    [
        { status: 'invalid', response: { status: 503 } },
        ErrorClassification.RETRYABLE,
    ],

    [
        { code: 'ENOTFOUND', cause: { response: { status: 400 } } },
        ErrorClassification.PERMANENT,
    ],
    [
        {
            sandboxSetup: { operation: 'git-fetch', exitCode: 128 },
            cause: { statusCode: 403 },
        },
        ErrorClassification.PERMANENT,
    ],
    [
        { sandboxSetup: { operation: 'graph-install', exitCode: 1 } },
        ErrorClassification.RETRYABLE,
    ],
    [
        { sandboxSetup: { operation: 'graph-install', exitCode: 127 } },
        ErrorClassification.PERMANENT,
    ],

    [
        new Error('parser quoted HTTP 503, timeout and ECONNRESET'),
        ErrorClassification.PERMANENT,
    ],
    [
        new Error(
            'parser quoted timeout exceeded when trying to connect and temporarily unavailable',
        ),
        ErrorClassification.PERMANENT,
    ],
    [
        new Error('timeout exceeded when trying to connect'),
        ErrorClassification.RETRYABLE,
    ],
    [
        new Error('Connection terminated due to connection timeout'),
        ErrorClassification.RETRYABLE,
    ],
    [
        new Error('provider temporarily unavailable'),
        ErrorClassification.RETRYABLE,
    ],
    [
        new Error('Service temporarily unavailable.'),
        ErrorClassification.RETRYABLE,
    ],
    [
        queryFailed('57014', 'canceling statement due to user request'),
        ErrorClassification.RETRYABLE,
    ],
    [queryFailed('55P03', 'database error'), ErrorClassification.RETRYABLE],
    [queryFailed('40001'), ErrorClassification.RETRYABLE],
    [queryFailed('40P01'), ErrorClassification.RETRYABLE],
    [queryFailed('53300'), ErrorClassification.RETRYABLE],
    [queryFailed('57P01'), ErrorClassification.RETRYABLE],
    [queryFailed('57P02'), ErrorClassification.RETRYABLE],
    [queryFailed('57P03'), ErrorClassification.RETRYABLE],
    [queryFailed('08006'), ErrorClassification.RETRYABLE],
    [queryFailed('08P01'), ErrorClassification.RETRYABLE],
    [
        queryFailed('23505', 'timeout waiting on a duplicate key'),
        ErrorClassification.PERMANENT,
    ],
    [
        {
            sandboxSetup: { operation: 'graph-install', exitCode: 127 },
            message: 'timeout',
        },
        ErrorClassification.PERMANENT,
    ],
    [
        sdkSandboxError('503: upstream unavailable'),
        ErrorClassification.RETRYABLE,
    ],
    [sdkSandboxError('502: bad gateway'), ErrorClassification.RETRYABLE],
    [sdkSandboxError('504: upstream reset'), ErrorClassification.RETRYABLE],
    [sdkSandboxError('500: internal error'), ErrorClassification.PERMANENT],
    [sdkSandboxError('500: connection timeout'), ErrorClassification.PERMANENT],
    [
        sdkSandboxError('Failed to start MCP gateway: 503: upstream'),
        ErrorClassification.PERMANENT,
    ],
    [
        Object.assign(sdkSandboxError('503: upstream unavailable'), {
            status: 400,
        }),
        ErrorClassification.PERMANENT,
    ],
    [
        Object.assign(sdkSandboxError('503: upstream unavailable'), {
            cause: { status: 400 },
        }),
        ErrorClassification.PERMANENT,
    ],
    [
        new AggregateError([
            sdkSandboxError('500: internal error'),
            { code: 'ECONNRESET' },
        ]),
        ErrorClassification.RETRYABLE,
    ],
    [
        { message: 'timeout', response: { status: 403 } },
        ErrorClassification.PERMANENT,
    ],
    [
        { cause: { cause: { response: { status: 503 } } } },
        ErrorClassification.RETRYABLE,
    ],
    [{ cause: { code: 'EAI_AGAIN' } }, ErrorClassification.RETRYABLE],
    [{ name: 'SandboxCreateTimeoutError' }, ErrorClassification.RETRYABLE],
    [{ statusCode: 429 }, ErrorClassification.RETRYABLE],
    [{ result: { stderr: 'sandbox timeout' } }, ErrorClassification.PERMANENT],
])('classifies structured graph errors %j', (error, classification) => {
    expect(classifyGraphJobError(error)).toBe(classification);
});

it('builds the E2B SDK SandboxError shape', () => {
    const error = sdkSandboxError('503: upstream');
    expect(error.name).toBe('SandboxError');
    expect(error.message).toBe('503: upstream');
    expect(
        Object.getOwnPropertyNames(error)
            .filter((key) => key !== 'stack')
            .sort(),
    ).toEqual(['message', 'name']);
});

it('terminates on a circular provider cause', () => {
    const error = new Error('cycle');
    Object.assign(error, { cause: error, lastError: error, errors: [error] });
    expect(classifyGraphJobError(error)).toBe(ErrorClassification.PERMANENT);
});
