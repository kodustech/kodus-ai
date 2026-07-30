import { BeaconHttpProvider } from '@libs/telemetry/infrastructure/providers/beacon-http.provider';

describe('BeaconHttpProvider', () => {
    const originalFetch = global.fetch;
    const originalEnv = { ...process.env };

    afterEach(() => {
        global.fetch = originalFetch;
        process.env = { ...originalEnv };
        jest.restoreAllMocks();
    });

    describe('isDisabled', () => {
        it.each(['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'On'])(
            'returns true for KODUS_TELEMETRY_DISABLED=%s',
            (value) => {
                process.env.KODUS_TELEMETRY_DISABLED = value;

                expect(new BeaconHttpProvider().isDisabled()).toBe(true);
            },
        );

        it.each(['', '0', 'false', 'no', 'off', 'maybe'])(
            'returns false for KODUS_TELEMETRY_DISABLED=%s',
            (value) => {
                process.env.KODUS_TELEMETRY_DISABLED = value;

                expect(new BeaconHttpProvider().isDisabled()).toBe(false);
            },
        );

        it('returns false when the var is not set', () => {
            delete process.env.KODUS_TELEMETRY_DISABLED;

            expect(new BeaconHttpProvider().isDisabled()).toBe(false);
        });
    });

    describe('send', () => {
        it('returns true on 204', async () => {
            global.fetch = jest
                .fn()
                .mockResolvedValue({ status: 204 }) as unknown as typeof fetch;

            const ok = await new BeaconHttpProvider().send({ a: 1 }, '1.0.0');

            expect(ok).toBe(true);
            expect(global.fetch).toHaveBeenCalledWith(
                'https://telemetry.kodus.io/v1/heartbeat',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Content-Type': 'application/json',
                        'User-Agent': 'kodus-self-hosted/1.0.0',
                    }),
                }),
            );
        });

        it('uses KODUS_TELEMETRY_ENDPOINT when set', async () => {
            process.env.KODUS_TELEMETRY_ENDPOINT =
                'http://127.0.0.1:43111/test-heartbeat';
            global.fetch = jest
                .fn()
                .mockResolvedValue({ status: 204 }) as unknown as typeof fetch;

            const ok = await new BeaconHttpProvider().send({ a: 1 }, '1.0.0');

            expect(ok).toBe(true);
            expect(global.fetch).toHaveBeenCalledWith(
                'http://127.0.0.1:43111/test-heartbeat',
                expect.objectContaining({
                    method: 'POST',
                }),
            );
        });

        it('returns false on non-204 (e.g. 400)', async () => {
            global.fetch = jest
                .fn()
                .mockResolvedValue({ status: 400 }) as unknown as typeof fetch;

            const ok = await new BeaconHttpProvider().send({}, '1.0.0');

            expect(ok).toBe(false);
        });

        it('returns false on transport error', async () => {
            global.fetch = jest
                .fn()
                .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

            const ok = await new BeaconHttpProvider().send({}, '1.0.0');

            expect(ok).toBe(false);
        });
    });
});
