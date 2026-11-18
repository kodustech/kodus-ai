const { deepSanitize, sanitizeString } = jest.requireActual(
    '@libs/core/log/logger',
) as {
    deepSanitize: (value: unknown) => unknown;
    sanitizeString: (value: string) => string;
};

// The Runtime gateway adds a sealed-token context header. It must inherit
// credential redaction even when an HTTP client serializes the whole head.
describe('Runtime model-turn context redaction', () => {
    const context = 'sealed-context-sentinel-that-must-never-be-logged';

    it('redacts the context in structured request headers without hiding routing diagnostics', () => {
        const out = deepSanitize({
            request: {
                headers: {
                    'X-Runtime-Sealed-Token': context,
                    'content-type': 'application/json',
                },
            },
            runId: 'run-correlation',
            statusCode: 401,
        });
        expect(JSON.stringify(out)).not.toContain(context);
        expect(out).toMatchObject({
            runId: 'run-correlation',
            statusCode: 401,
        });
    });

    it('redacts the context from serialized HTTP header lines', () => {
        const out = sanitizeString(
            `POST /internal/runtime/model-turn HTTP/1.1\r\nx-runtime-sealed-token: ${context}\r\nContent-Type: application/json\r\n`,
        );
        expect(out).not.toContain(context);
        expect(out).toContain('[REDACTED]');
        expect(out).toContain('Content-Type: application/json');
    });

    it('is filtered by the installed Sentry request-header collector too', () => {
        const sentry = createRequire(require.resolve('@sentry/nestjs'));
        const core = dirname(sentry.resolve('@sentry/core'));
        const { filterKeyValueData } = sentry(
            join(core, 'utils/data-collection/filterKeyValueData.js'),
        );
        const out = filterKeyValueData(
            {
                'x-runtime-sealed-token': context,
                'content-type': 'application/json',
            },
            true,
        );
        expect(out['x-runtime-sealed-token']).toBe('[Filtered]');
        expect(out['content-type']).toBe('application/json');
    });
});
import { createRequire } from 'module';
import { dirname, join } from 'path';
