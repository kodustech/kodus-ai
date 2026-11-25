import pino from 'pino';

jest.unmock('@libs/core/log/logger');
jest.resetModules();

const { boundErrorForLog, capSerialized, extractErrorProps } =
    require('./logger') as typeof import('./logger');

const serializers = [
    ['error', extractErrorProps],
    ['err', boundErrorForLog],
] as const;

function retryError(lastError: unknown): Error {
    return Object.assign(new Error('retries exhausted'), { lastError });
}

describe.each(serializers)('%s HTTP diagnostics', (_name, serialize) => {
    it.each(
        ['key', 'auth', 'api_token', 'access_key', 'custom_credential'].flatMap(
            (parameter) =>
                ['direct', 'retry'].map((shape) => [parameter, shape] as const),
        ),
    )('drops the entire URL query, including %s (%s)', (parameter, shape) => {
        const url = `https://api.gateway.invalid/v1/messages?${parameter}=fixture-credential&region=west#private-fragment`;
        const error =
            shape === 'direct'
                ? Object.assign(new Error('request failed'), { url })
                : retryError({ url });
        const result = serialize(error);
        expect(result.url).toBe('https://api.gateway.invalid/v1/messages');
        expect(JSON.stringify(result)).not.toContain('fixture-credential');
        expect(JSON.stringify(result)).not.toContain('private-fragment');
    });

    it('drops a fragment without a query and still redacts URL userinfo', () => {
        const result = serialize(
            retryError({
                url: 'https://user:fixture-password@api.gateway.invalid/v1#fixture-fragment',
            }),
        );
        expect(result.url).toBe(
            'https://user:[REDACTED]@api.gateway.invalid/v1',
        );
    });

    it('reads each nested diagnostic once and uses that same value', () => {
        const values = {
            statusCode: 429,
            url: 'https://api.gateway.invalid/v1',
            responseBody: 'body',
        };
        const inner = {};
        const reads = Object.fromEntries(
            Object.entries(values).map(([key, value]) => {
                const get = jest.fn(() => {
                    if (get.mock.calls.length > 1) {
                        throw new Error(`second read of ${key}`);
                    }
                    return value;
                });
                Object.defineProperty(inner, key, { get });
                return [key, get];
            }),
        );
        const result = serialize(retryError(inner));
        expect(result).toMatchObject({
            statusCode: 429,
            url: values.url,
            responseBodyLength: 4,
        });
        for (const read of Object.values(reads)) {
            expect(read).toHaveBeenCalledTimes(1);
        }
    });

    it.each(['statusCode', 'url', 'responseBody'])(
        'skips a throwing %s getter without dropping the other diagnostics',
        (key) => {
            const inner = {
                statusCode: 429,
                status: 503,
                url: 'https://api.gateway.invalid/v1',
                responseBody: 'body',
            };
            const get = jest.fn(() => {
                throw new Error('unreadable field');
            });
            Object.defineProperty(inner, key, { get });
            const result = serialize(retryError(inner));
            expect(result.statusCode).toBe(key === 'statusCode' ? 503 : 429);
            expect(result.url).toBe(
                key === 'url' ? undefined : 'https://api.gateway.invalid/v1',
            );
            expect(result.responseBodyLength).toBe(
                key === 'responseBody' ? undefined : 4,
            );
            expect(get).toHaveBeenCalledTimes(1);
        },
    );

    it('reads a fallback status only when statusCode is absent', () => {
        const status = jest.fn(() => 503);
        const inner = { statusCode: 429 };
        Object.defineProperty(inner, 'status', { get: status });
        expect(serialize(retryError(inner)).statusCode).toBe(429);
        expect(status).not.toHaveBeenCalled();
        expect(serialize(retryError({ status: 503 })).statusCode).toBe(503);
    });

    it('ignores a throwing lastError getter', () => {
        const error = Object.assign(new Error('failed'), { statusCode: 500 });
        Object.defineProperty(error, 'lastError', {
            get() {
                throw new Error('unreadable inner error');
            },
        });
        expect(serialize(error).statusCode).toBe(500);
    });
});

describe('HTTP diagnostic sibling paths', () => {
    it('keeps provider credentials out of the actual pino JSON line', () => {
        const lines: string[] = [];
        const logger = pino(
            { serializers: { err: boundErrorForLog } },
            { write: (line: string) => lines.push(line) },
        );
        const body = 'private provider response';
        const error = retryError({
            statusCode: 429,
            url: 'https://api.gateway.invalid/v1?custom=fixture-credential#private',
            responseBody: body,
        });
        logger.error(
            {
                err: error,
                error: extractErrorProps(error),
                traceId: 'trace-fixture',
            },
            'review failed',
        );
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain('fixture-credential');
        expect(lines[0]).not.toContain('private provider response');
        const emitted = JSON.parse(lines[0]);
        for (const key of ['err', 'error']) {
            expect(emitted[key]).toMatchObject({
                statusCode: 429,
                url: 'https://api.gateway.invalid/v1',
                responseBodyLength: body.length,
            });
        }
        expect(emitted.traceId).toBe('trace-fixture');
    });

    it('drops query and fragment from the axios config URL too', () => {
        const result = boundErrorForLog(
            Object.assign(new Error('request failed'), {
                config: {
                    method: 'post',
                    url: 'https://api.gateway.invalid/v1?custom=fixture-credential#private',
                },
            }),
        );
        expect(result.config).toEqual({
            method: 'post',
            url: 'https://api.gateway.invalid/v1',
        });
    });

    it('reads each Axios context field once', () => {
        const url = jest.fn(() => {
            if (url.mock.calls.length > 1) {
                throw new Error('second URL read');
            }
            return 'https://api.gateway.invalid/v1';
        });
        const method = jest.fn(() => 'post');
        const config = Object.defineProperties(
            {},
            {
                url: { get: url },
                method: { get: method },
            },
        );
        const result = boundErrorForLog(
            Object.assign(new Error('failed'), { config }),
        );
        expect(result.config).toEqual({
            method: 'post',
            url: 'https://api.gateway.invalid/v1',
        });
        expect(url).toHaveBeenCalledTimes(1);
        expect(method).toHaveBeenCalledTimes(1);
    });

    it('retains the Axios URL when the method getter throws', () => {
        const method = jest.fn(() => {
            throw new Error('unreadable method');
        });
        const config = Object.defineProperty(
            { url: 'https://api.gateway.invalid/v1' },
            'method',
            { get: method },
        );
        const result = boundErrorForLog(
            Object.assign(new Error('failed'), { config }),
        );
        expect(result.config).toEqual({
            url: 'https://api.gateway.invalid/v1',
        });
        expect(method).toHaveBeenCalledTimes(1);
    });

    it.each(['organizationAndTeamData', 'organizationId'])(
        'falls back to the root organization id when nested %s throws',
        (key) => {
            const get = jest.fn(() => {
                throw new Error('unreadable organization context');
            });
            const target = {
                organizationId: 'org-root',
                toJSON() {
                    throw new Error('cannot serialize');
                },
            };
            Object.defineProperty(
                target,
                'organizationAndTeamData',
                key === 'organizationAndTeamData'
                    ? { get }
                    : {
                          value: Object.defineProperty({}, 'organizationId', {
                              get,
                          }),
                      },
            );
            const report = jest.fn();
            expect(capSerialized(target, 2_000, report)).toBe(
                '[unserializable value]',
            );
            expect(report).toHaveBeenCalledWith(
                expect.objectContaining({ organizationId: 'org-root' }),
            );
            expect(get).toHaveBeenCalledTimes(1);
        },
    );

    it('reads the outer response body once when deriving its length', () => {
        const error = new Error('request failed');
        const get = jest.fn(() => {
            if (get.mock.calls.length > 1) {
                throw new Error('second responseBody read');
            }
            return 'body';
        });
        Object.defineProperty(error, 'responseBody', { get });
        expect(extractErrorProps(error).responseBodyLength).toBe(4);
        expect(get).toHaveBeenCalledTimes(1);
    });

    it('skips an unreadable outer diagnostic and retains the other fields', () => {
        const error = Object.assign(new Error('failed'), {
            statusCode: 429,
            url: 'https://api.gateway.invalid/v1',
        });
        Object.defineProperty(error, 'statusCode', {
            get() {
                throw new Error('unreadable status');
            },
        });
        expect(extractErrorProps(error)).toEqual({
            url: 'https://api.gateway.invalid/v1',
        });
    });

    it.each(['nested', 'top-level'])(
        'reads the %s organization id once when reporting an unserializable prop',
        (shape) => {
            const get = jest.fn(() => {
                if (get.mock.calls.length > 1) {
                    throw new Error('second organizationId read');
                }
                return 'org-fixture';
            });
            const target = {
                toJSON() {
                    throw new Error('cannot serialize');
                },
            };
            const record = Object.defineProperty({}, 'organizationId', { get });
            Object.defineProperty(
                target,
                shape === 'nested'
                    ? 'organizationAndTeamData'
                    : 'organizationId',
                shape === 'nested' ? { value: record } : { get },
            );
            const report = jest.fn();
            expect(capSerialized(target, 2_000, report)).toBe(
                '[unserializable value]',
            );
            expect(report).toHaveBeenCalledWith(
                expect.objectContaining({ organizationId: 'org-fixture' }),
            );
            expect(get).toHaveBeenCalledTimes(1);
        },
    );
});
