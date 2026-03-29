import { formatHeartbeatContext } from './heartbeat-context.util';

describe('formatHeartbeatContext', () => {
    it('uses explicit environment and component fields', () => {
        const context = formatHeartbeatContext('production', 'worker', {
            monitor: 'webhook_failure_rate',
        });

        expect(context).toContain('env=production');
        expect(context).toContain('component=worker');
        expect(context).toContain('monitor=webhook_failure_rate');
    });

    it('omits empty environment and component values', () => {
        const context = formatHeartbeatContext(undefined, undefined, {
            monitor: 'webhook_failure_rate',
        });

        expect(context).not.toContain('env=');
        expect(context).not.toContain('component=');
        expect(context).toContain('monitor=webhook_failure_rate');
    });
});
