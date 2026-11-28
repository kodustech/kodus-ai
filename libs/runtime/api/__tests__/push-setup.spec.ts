import { isSetupInFlight, type SetupInFlightFacts } from '../domain/push-setup';

const at = (iso: string) => new Date(iso);

describe('isSetupInFlight', () => {
    // Two setups of one environment raced: the push's (requested 12:00) landed its record after the later
    // "Set up again" (requested 12:01), so the record on file is older than the product's last request.
    const raced: SetupInFlightFacts = {
        productState: 'setup_requested',
        setupRequestedAt: '2026-11-26T12:01:00.000Z',
        record: { state: 'active', requestedAt: '2026-11-26T12:00:00.000Z', updatedAt: '2026-11-26T12:30:00.000Z', sha: 'a'.repeat(40) },
    };

    it('does not hold a push back for a setup that already ended after the request, whichever record landed last', () => {
        expect(isSetupInFlight(raced, at('2026-11-26T12:40:00.000Z'))).toBe(false);
    });

    it('still holds a push back while the record says a setup is running', () => {
        const running = { ...raced, record: { ...raced.record!, state: 'setting_up' as const } };
        expect(isSetupInFlight(running, at('2026-11-26T12:40:00.000Z'))).toBe(true);
    });

    it('still holds a push back for a request the worker has not answered since it was made', () => {
        const queued = { ...raced, record: { ...raced.record!, updatedAt: '2026-11-26T11:59:00.000Z' } };
        expect(isSetupInFlight(queued, at('2026-11-26T12:40:00.000Z'))).toBe(true);
    });
});
