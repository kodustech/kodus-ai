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
