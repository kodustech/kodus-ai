import { ConfigService } from '@nestjs/config';

import { ResendEventsProvider } from '@libs/telemetry/infrastructure/providers/resend-events.provider';

const mockLogger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

jest.mock('@kodus/flow', () => ({
    createLogger: () => mockLogger,
}));

const mockEventsSend = jest.fn();
const MockResend = jest
    .fn()
    .mockImplementation(() => ({ events: { send: mockEventsSend } }));

jest.mock('resend', () => ({
    Resend: jest.fn((...args) => MockResend(...args)),
}));

describe('ResendEventsProvider', () => {
    const buildConfig = (overrides: Record<string, string | undefined> = {}) =>
        ({
            get: jest.fn((key: string) => overrides[key]),
        }) as unknown as ConfigService;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('when RESEND_API_KEY is missing', () => {
        it('reports isEnabled = false and does not construct the SDK', async () => {
            const provider = new ResendEventsProvider(buildConfig({}));

            expect(provider.isEnabled).toBe(false);
            await provider.send('user.signed_up', 'a@b.com', { foo: 'bar' });
            expect(MockResend).not.toHaveBeenCalled();
            expect(mockEventsSend).not.toHaveBeenCalled();
        });
    });

    describe('when RESEND_API_KEY is present', () => {
        it('forwards event/email/payload exactly to events.send', async () => {
            mockEventsSend.mockResolvedValueOnce({ data: { id: 'evt_1' } });
            const provider = new ResendEventsProvider(
                buildConfig({ RESEND_API_KEY: 're_test' }),
            );

            await provider.send('user.signed_up', 'a@b.com', {
                userId: 'u-1',
                organizationName: 'Acme',
            });

            expect(MockResend).toHaveBeenCalledTimes(1);
            expect(MockResend).toHaveBeenCalledWith('re_test');
            expect(mockEventsSend).toHaveBeenCalledTimes(1);
            expect(mockEventsSend).toHaveBeenCalledWith({
                event: 'user.signed_up',
                email: 'a@b.com',
                payload: { userId: 'u-1', organizationName: 'Acme' },
            });
        });

        it('caches the SDK client across calls (only constructs once)', async () => {
            mockEventsSend.mockResolvedValue({ data: { id: 'x' } });
            const provider = new ResendEventsProvider(
                buildConfig({ RESEND_API_KEY: 're_test' }),
            );

            await provider.send('a', 'a@b.com', {});
            await provider.send('b', 'a@b.com', {});
            await provider.send('c', 'a@b.com', {});

            expect(MockResend).toHaveBeenCalledTimes(1);
            expect(mockEventsSend).toHaveBeenCalledTimes(3);
        });

        // The host flow (signup, onboarding) cannot break because Resend
        // returned 422/500 or threw a network error.
        describe('resilience', () => {
            it('logs warn and returns void when API returns an error object', async () => {
                mockEventsSend.mockResolvedValueOnce({
                    error: { message: 'event not found' },
                });
                const provider = new ResendEventsProvider(
                    buildConfig({ RESEND_API_KEY: 're_test' }),
                );

                await expect(
                    provider.send('user.signed_up', 'a@b.com', {}),
                ).resolves.toBeUndefined();
                expect(mockLogger.warn).toHaveBeenCalledTimes(1);
                expect(mockLogger.warn.mock.calls[0][0].message).toContain(
                    'Resend events.send failed',
                );
            });

            it('logs warn and returns void when SDK throws (network)', async () => {
                mockEventsSend.mockRejectedValueOnce(
                    new Error('ECONNRESET socket hang up'),
                );
                const provider = new ResendEventsProvider(
                    buildConfig({ RESEND_API_KEY: 're_test' }),
                );

                await expect(
                    provider.send('user.signed_up', 'a@b.com', {}),
                ).resolves.toBeUndefined();
                expect(mockLogger.warn).toHaveBeenCalledTimes(1);
                expect(mockLogger.warn.mock.calls[0][0].message).toContain(
                    'Resend events.send threw',
                );
            });
        });
    });
});
