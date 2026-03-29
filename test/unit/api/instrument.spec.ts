describe('apps/api instrument bootstrap', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('loads dotenv before initializing Sentry', async () => {
        let dotenvLoaded = false;
        const setupSentry = jest.fn(() => dotenvLoaded);

        jest.doMock('dotenv/config', () => {
            dotenvLoaded = true;
            return {};
        });

        jest.doMock('@libs/core/infrastructure/config/log/sentry', () => ({
            setupSentry,
        }));

        await import('../../../apps/api/src/instrument');

        expect(setupSentry).toHaveBeenCalledTimes(1);
        expect(setupSentry).toHaveBeenCalledWith('api');
        expect(dotenvLoaded).toBe(true);
    });
});
