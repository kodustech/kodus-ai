import { ConfigService } from '@nestjs/config';

import { N8nProvider } from '@libs/telemetry/infrastructure/providers/n8n.provider';

const mockLogger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

jest.mock('@kodus/flow', () => ({
    createLogger: () => mockLogger,
}));

describe('N8nProvider', () => {
    const buildConfig = (overrides: Record<string, string | undefined> = {}) =>
        ({
            get: jest.fn((key: string) => overrides[key]),
        }) as unknown as ConfigService;

    let fetchMock: jest.SpyInstance;
    let originalSetTimeout: typeof setTimeout;

    beforeEach(() => {
        jest.clearAllMocks();
        fetchMock = jest.spyOn(globalThis, 'fetch' as any);
        // The provider sleeps 500ms between retries; collapse those waits
        // so failure-path tests don't take seconds. We still verify retry
        // behavior by counting fetch calls — timing is not the contract.
        originalSetTimeout = globalThis.setTimeout;
        (globalThis as any).setTimeout = (fn: () => void) => {
            fn();
            return 0 as unknown as ReturnType<typeof setTimeout>;
        };
    });

    afterEach(() => {
        fetchMock.mockRestore();
        (globalThis as any).setTimeout = originalSetTimeout;
    });

    // ─── Env-resolution contract ─────────────────────────────────────────
    // The new env (`N8N_WEBHOOK_URL`) wins over the legacy fallback
    // (`API_SIGNUP_NOTIFICATION_WEBHOOK`) so prod can be migrated without a
    // window where the new env exists but is shadowed by the old one.
    describe('env resolution', () => {
        it('reports disabled and does not call fetch when no env is set', async () => {
            const provider = new N8nProvider(buildConfig({}));

            expect(provider.isEnabled).toBe(false);
            await provider.notify('user.signed_up', { foo: 'bar' });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('uses N8N_WEBHOOK_URL when both new and legacy envs are set', async () => {
            fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as any);
            const provider = new N8nProvider(
                buildConfig({
                    N8N_WEBHOOK_URL: 'https://new.example.com/hook',
                    API_SIGNUP_NOTIFICATION_WEBHOOK:
                        'https://legacy.example.com/hook',
                }),
            );

            await provider.notify('user.signed_up', {});

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock.mock.calls[0][0]).toBe(
                'https://new.example.com/hook',
            );
        });

        it('falls back to API_SIGNUP_NOTIFICATION_WEBHOOK when only legacy is set', async () => {
            fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as any);
            const provider = new N8nProvider(
                buildConfig({
                    API_SIGNUP_NOTIFICATION_WEBHOOK:
                        'https://legacy.example.com/hook',
                }),
            );

            await provider.notify('user.signed_up', {});

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock.mock.calls[0][0]).toBe(
                'https://legacy.example.com/hook',
            );
        });
    });

    describe('payload shape', () => {
        it('POSTs JSON with eventId, props, and an ISO timestamp', async () => {
            fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as any);
            const provider = new N8nProvider(
                buildConfig({ N8N_WEBHOOK_URL: 'https://h' }),
            );

            await provider.notify('user.signed_up', {
                userId: 'u-1',
                email: 'a@b.com',
            });

            const [, init] = fetchMock.mock.calls[0];
            expect(init.method).toBe('POST');
            expect(init.headers).toEqual({
                'Content-Type': 'application/json',
            });

            const body = JSON.parse(init.body as string);
            expect(body.eventId).toBe('user.signed_up');
            expect(body.props).toEqual({ userId: 'u-1', email: 'a@b.com' });
            // ISO 8601, parseable as a Date.
            expect(new Date(body.timestamp).toString()).not.toBe(
                'Invalid Date',
            );
        });
    });

    describe('retry + resilience', () => {
        it('does not retry on 2xx', async () => {
            fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as any);
            const provider = new N8nProvider(
                buildConfig({ N8N_WEBHOOK_URL: 'https://h' }),
            );

            await provider.notify('e', {});

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        it('retries once on 5xx, succeeds, no warn', async () => {
            fetchMock
                .mockResolvedValueOnce({ ok: false, status: 503 } as any)
                .mockResolvedValueOnce({ ok: true, status: 200 } as any);
            const provider = new N8nProvider(
                buildConfig({ N8N_WEBHOOK_URL: 'https://h' }),
            );

            await provider.notify('e', {});

            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        it('retries once on thrown error, succeeds, no warn', async () => {
            fetchMock
                .mockRejectedValueOnce(new Error('ECONNRESET'))
                .mockResolvedValueOnce({ ok: true, status: 200 } as any);
            const provider = new N8nProvider(
                buildConfig({ N8N_WEBHOOK_URL: 'https://h' }),
            );

            await provider.notify('e', {});

            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        it('logs warn and returns void after both attempts return non-ok', async () => {
            fetchMock
                .mockResolvedValueOnce({ ok: false, status: 503 } as any)
                .mockResolvedValueOnce({ ok: false, status: 503 } as any);
            const provider = new N8nProvider(
                buildConfig({ N8N_WEBHOOK_URL: 'https://h' }),
            );

            await expect(provider.notify('e', {})).resolves.toBeUndefined();

            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn.mock.calls[0][0].message).toContain(
                'n8n webhook returned 503',
            );
        });

        it('logs warn and returns void after both attempts throw', async () => {
            fetchMock
                .mockRejectedValueOnce(new Error('boom'))
                .mockRejectedValueOnce(new Error('boom again'));
            const provider = new N8nProvider(
                buildConfig({ N8N_WEBHOOK_URL: 'https://h' }),
            );

            await expect(provider.notify('e', {})).resolves.toBeUndefined();

            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn.mock.calls[0][0].message).toContain(
                'n8n webhook threw',
            );
        });
    });
});
