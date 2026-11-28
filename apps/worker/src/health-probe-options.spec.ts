import { workerHealthProbeOptions } from './health-probe-options';
import { SECURITY_SCAN_WORKER_CHANNELS } from './health-probe';

/**
 * The outbox relay check came with the Runtime. With the Runtime off, a
 * code-review worker's health is main's: AMQP and its consumers only, so a
 * stalled relay cycle never recycles a worker in the middle of a review.
 */
describe('workerHealthProbeOptions', () => {
    it('does not check the outbox relay on a code-review worker when the Runtime is off', () => {
        expect(
            workerHealthProbeOptions('code-review', { RUNTIME_ENABLED: 'false' }),
        ).toEqual({ requireAmqp: true, requireOutboxRelay: false });
        expect(workerHealthProbeOptions('code-review', {})).toEqual({
            requireAmqp: true,
            requireOutboxRelay: false,
        });
    });

    it('checks the outbox relay on a code-review worker when the Runtime is on', () => {
        expect(
            workerHealthProbeOptions('code-review', { RUNTIME_ENABLED: 'true' }),
        ).toEqual({ requireAmqp: true, requireOutboxRelay: true });
    });

    it('never checks the relay on the roles that do not run it', () => {
        const on = { RUNTIME_ENABLED: 'true' };
        expect(workerHealthProbeOptions('analytics', on)).toEqual({
            requireAmqp: false,
            requireOutboxRelay: false,
        });
        expect(workerHealthProbeOptions('security-scan', on)).toEqual({
            requireAmqp: true,
            requireOutboxRelay: false,
            requiredChannels: SECURITY_SCAN_WORKER_CHANNELS,
        });
    });

    it('needs no AMQP when RabbitMQ is disabled', () => {
        expect(
            workerHealthProbeOptions('code-review', {
                API_RABBITMQ_ENABLED: 'false',
                RUNTIME_ENABLED: 'true',
            }),
        ).toEqual({ requireAmqp: false, requireOutboxRelay: true });
    });
});
