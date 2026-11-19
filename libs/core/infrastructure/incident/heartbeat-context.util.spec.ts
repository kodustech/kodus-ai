import { setRuntimeTaskId } from '@libs/core/log/runtime-identity';

import {
    buildHeartbeatContext,
    formatHeartbeatContext,
} from './heartbeat-context.util';

describe('formatHeartbeatContext', () => {
    const release = process.env.RELEASE_VERSION;
    afterEach(() => {
        if (release === undefined) delete process.env.RELEASE_VERSION;
        else process.env.RELEASE_VERSION = release;
        setRuntimeTaskId(undefined);
    });

    it('names the release and the ECS task that sent the alert', () => {
        process.env.RELEASE_VERSION = '2.2.18';
        setRuntimeTaskId('0b7a3a5a1234');

        expect(
            formatHeartbeatContext('production', 'worker', { monitor: 'm' }),
        ).toContain('version=2.2.18 taskId=0b7a3a5a1234');
        expect(buildHeartbeatContext('production', 'worker')).toEqual(
            expect.objectContaining({
                version: '2.2.18',
                taskId: '0b7a3a5a1234',
            }),
        );
    });

    it('leaves version and task out when they are unknown', () => {
        delete process.env.RELEASE_VERSION;

        const context = formatHeartbeatContext('production', 'worker');
        expect(context).not.toContain('version=');
        expect(context).not.toContain('taskId=');
    });

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
