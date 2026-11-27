import { isTransientProviderError } from './transient-provider-error';

const withStatus = (status: number, extra: object = {}) =>
    Object.assign(new Error(`HTTP ${status}`), { status }, extra);

describe('isTransientProviderError', () => {
    it.each([500, 502, 503, 429])('is transient on %s', (status) => {
        expect(isTransientProviderError(withStatus(status))).toBe(true);
    });

    it.each([400, 401, 404])('is lasting on %s', (status) => {
        expect(isTransientProviderError(withStatus(status))).toBe(false);
    });

    it('reads the status from an axios response and a gitbeaker cause', () => {
        expect(isTransientProviderError({ response: { status: 503 } })).toBe(
            true,
        );
        expect(
            isTransientProviderError({ cause: { response: { status: 429 } } }),
        ).toBe(true);
    });

    it('is transient on a 403 that carries rate-limit headers, lasting on a plain 403', () => {
        expect(
            isTransientProviderError({
                status: 403,
                response: {
                    status: 403,
                    headers: { 'x-ratelimit-remaining': '0' },
                },
            }),
        ).toBe(true);
        expect(isTransientProviderError(withStatus(403))).toBe(false);
    });

    it('is transient when nothing answered, lasting on a programming error', () => {
        expect(
            isTransientProviderError(
                Object.assign(new Error('socket'), { code: 'ECONNRESET' }),
            ),
        ).toBe(true);
        expect(
            isTransientProviderError(
                new TypeError('fetch failed', {
                    cause: Object.assign(new Error('x'), {
                        code: 'UND_ERR_CONNECT_TIMEOUT',
                    }),
                }),
            ),
        ).toBe(true);
        expect(
            isTransientProviderError(
                new TypeError(
                    "Cannot read properties of undefined (reading 'id')",
                ),
            ),
        ).toBe(false);
    });
});
