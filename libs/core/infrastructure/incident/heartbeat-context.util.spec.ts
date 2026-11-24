import { formatHeartbeatContext } from './heartbeat-context.util';

/**
 * The release is read once, when the process loads the module: each case
 * loads its own copy with the environment it describes.
 */
function loadWithRelease(release: string | undefined) {
    const saved = process.env.RELEASE_VERSION;
    if (release === undefined) delete process.env.RELEASE_VERSION;
    else process.env.RELEASE_VERSION = release;
    let loaded!: {
        setRuntimeTaskId: (id: string | undefined) => void;
        formatHeartbeatContext: typeof formatHeartbeatContext;
        buildHeartbeatContext: typeof import('./heartbeat-context.util').buildHeartbeatContext;
    };
    jest.isolateModules(() => {
        loaded = {
            ...require('@libs/core/log/runtime-identity'),
            ...require('./heartbeat-context.util'),
        };
    });
    if (saved === undefined) delete process.env.RELEASE_VERSION;
    else process.env.RELEASE_VERSION = saved;
    return loaded;
}

describe('formatHeartbeatContext', () => {
    it('names the release and the ECS task that sent the alert', () => {
        const {
            setRuntimeTaskId,
            formatHeartbeatContext,
            buildHeartbeatContext,
        } = loadWithRelease('2.2.18');
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
        const { formatHeartbeatContext } = loadWithRelease(undefined);

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
