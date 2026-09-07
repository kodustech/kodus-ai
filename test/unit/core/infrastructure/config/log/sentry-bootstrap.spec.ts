jest.mock('@sentry/nestjs', () => ({
    init: jest.fn(),
    isInitialized: jest.fn().mockReturnValue(false),
}));

describe('setupSentry', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        delete process.env.SENTRY_RELEASE;
        process.env.API_NODE_ENV = 'production';
        process.env.API_BETTERSTACK_DSN =
            'https://fake-dsn@s2315144.eu-fsn-3.betterstackdata.com/2315144';
    });

    it('initializes Sentry with the Better Stack DSN only once', async () => {
        const { setupSentry } =
            await import('@libs/core/infrastructure/config/log/sentry');
        const sentry = jest.requireMock('@sentry/nestjs') as {
            init: jest.Mock;
            isInitialized: jest.Mock;
        };

        sentry.isInitialized.mockReturnValueOnce(false).mockReturnValue(true);

        setupSentry('worker');
        setupSentry('worker');

        expect(sentry.init).toHaveBeenCalledTimes(1);
        expect(sentry.init).toHaveBeenCalledWith(
            expect.objectContaining({
                dsn: 'https://fake-dsn@s2315144.eu-fsn-3.betterstackdata.com/2315144',
                environment: 'production',
                release: 'kodus-orchestrator@production',
                serverName: 'kodus-worker',
            }),
        );
    });

    it('removes review context bodies from request data before reporting an event', async () => {
        const { setupSentry } =
            await import('@libs/core/infrastructure/config/log/sentry');
        const sentry = jest.requireMock('@sentry/nestjs') as {
            init: jest.Mock;
        };
        setupSentry('api');
        const options = sentry.init.mock.calls[0]?.[0] as {
            beforeSend?: (event: {
                request?: { data?: unknown };
            }) => { request?: { data?: unknown } } | null;
        };
        const canary = 'CANARY private review context';

        const result = options.beforeSend?.({
            request: {
                data: {
                    diff: 'diff',
                    reviewContext: {
                        source: 'cli-review-context-file',
                        contentType: 'text/plain; charset=utf-8',
                        body: canary,
                    },
                },
            },
        });

        expect(JSON.stringify(result)).not.toContain(canary);
        expect(result?.request?.data).toEqual({
            diff: 'diff',
            reviewContext: {
                source: 'cli-review-context-file',
                contentType: 'text/plain; charset=utf-8',
            },
        });
    });

    it('removes review context bodies from JSON-string request data', async () => {
        const { setupSentry } =
            await import('@libs/core/infrastructure/config/log/sentry');
        const sentry = jest.requireMock('@sentry/nestjs') as {
            init: jest.Mock;
        };
        setupSentry('api');
        const options = sentry.init.mock.calls[0]?.[0] as {
            beforeSend?: (event: {
                request?: { data?: unknown };
            }) => { request?: { data?: unknown } } | null;
        };
        const canary = 'CANARY private string request context';

        const result = options.beforeSend?.({
            request: {
                data: JSON.stringify({
                    diff: 'diff',
                    reviewContext: {
                        source: 'cli-review-context-file',
                        contentType: 'text/plain; charset=utf-8',
                        body: canary,
                    },
                }),
            },
        });

        expect(JSON.stringify(result)).not.toContain(canary);
        expect(JSON.parse(String(result?.request?.data))).toEqual({
            diff: 'diff',
            reviewContext: {
                source: 'cli-review-context-file',
                contentType: 'text/plain; charset=utf-8',
            },
        });
    });

    it('does not crash the platform if Sentry init throws', async () => {
        const { setupSentry } =
            await import('@libs/core/infrastructure/config/log/sentry');
        const sentry = jest.requireMock('@sentry/nestjs') as {
            init: jest.Mock;
        };
        const consoleWarn = jest
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);

        sentry.init.mockImplementation(() => {
            throw new Error('invalid dsn');
        });

        expect(() => setupSentry('api')).not.toThrow();
        expect(consoleWarn).toHaveBeenCalledWith(
            '[Sentry] initialization failed, continuing without error tracking:',
            'invalid dsn',
        );

        consoleWarn.mockRestore();
    });
});
