import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { classifyGraphJobError } from './graph-job-failure';

it.each([
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
    error.cause = error;
    expect(classifyGraphJobError(error)).toBe(ErrorClassification.PERMANENT);
});
