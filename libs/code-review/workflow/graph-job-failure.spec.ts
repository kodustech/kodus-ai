import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { classifyGraphJobError } from './graph-job-failure';

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

it('terminates on a circular provider cause', () => {
    const error = new Error('timeout');
    Object.assign(error, { cause: error, lastError: error, errors: [error] });
    expect(classifyGraphJobError(error)).toBe(ErrorClassification.PERMANENT);
});
