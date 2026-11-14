import { randomUUID } from 'crypto';
import { CellConnection } from '../gateway/cell-connections';
import { InMemoryHubStore } from '../hub-store';
import { StepDispatcher } from './step-dispatcher';

function fixture(
    metadata: any,
    replaceOnLookup = false,
    replaceOnStarted = false,
) {
    const claim = {
        cellId: 'cell-a',
        claimId: 'claim-a',
        orgId: 'org-a',
        runId: null,
        side: 'pr',
        state: 'bound',
    };
    const connection = () => {
        const c = new CellConnection(
            { send: () => {}, close: () => {} },
            { cellId: 'cell-a', owner: 'kodus' },
        );
        c.helloDone = true;
        return c;
    };
    const initial = connection();
    let current = initial;
    const frames: any[] = [];
    let dispatcher: StepDispatcher;
    const registry = {
        ack: () => {},
        get: () => current,
        isCurrent: (c: any) => c === current,
        envelope: (cellId: any, type: any, body: any, extra: any) => ({
            v: 1,
            id: randomUUID(),
            cellId,
            type,
            body,
            ...extra,
        }),
        send: (c: any, frame: any) => {
            frames.push(frame);
            queueMicrotask(
                () =>
                    void dispatcher.onStepFrame(c, {
                        v: 1,
                        id: randomUUID(),
                        cellId: 'cell-a',
                        claimId: 'claim-a',
                        type: 'step.result',
                        body: {
                            stepId: frame.body.stepId,
                            executor: 'vm',
                            imageId: 'image-a',
                            vmHealth: 'ok',
                            exec: {
                                exitCode: 9,
                                stdout: 'internal check',
                                stderr: '',
                                truncated: false,
                                durationMs: 2,
                            },
                        },
                    }),
            );
            return true;
        },
    };
    dispatcher = new StepDispatcher(
        {
            findActiveClaim: async () => claim,
            scoped: async () => claim,
        } as any,
        new InMemoryHubStore(),
        registry as any,
        async (_org, _run, event) => {
            if (replaceOnStarted && event.type === 'step.started')
                current = connection();
        },
        { recordProtocolViolation: () => {} } as any,
        { step: () => {} } as any,
        () => {},
        async () => {
            if (replaceOnLookup) current = connection();
            return metadata === null
                ? null
                : { sessionEpoch: initial.sessionEpoch, ...metadata };
        },
    );
    return {
        frames,
        run: () =>
            dispatcher.exec(
                { claimId: 'claim-a', organizationId: 'org-a' },
                {
                    stepId: randomUUID(),
                    command: 'pnpm test',
                    timeoutMs: 1000,
                    executionScope: 'workload',
                },
            ),
    };
}

describe('workload-only internal validation dispatch', () => {
    it.each([
        null,
        {},
        { driver: 'local-docker', isolation: 'none' },
        { driver: 'docker-gvisor', isolation: 'none' },
        { driver: 'aws-ec2', isolation: 'vm' },
    ])(
        'refuses absent or unsupported current session metadata: %j',
        async (metadata) => {
            const f = fixture(metadata);
            expect(await f.run()).toMatchObject({
                code: 'workload_exec_unavailable',
            });
            expect(f.frames).toEqual([]);
        },
    );
    it('fences a reconnect before execution, including a potential driver downgrade', async () => {
        const f = fixture(
            { driver: 'docker-gvisor', isolation: 'sandboxed-container' },
            true,
        );
        expect(await f.run()).toMatchObject({ code: 'cell_unavailable' });
        expect(f.frames).toEqual([]);
    });
    it('records lost transport if replacement happens after step registration but before the frame', async () => {
        const f = fixture(
            { driver: 'docker-gvisor', isolation: 'sandboxed-container' },
            false,
            true,
        );
        expect(await f.run()).toMatchObject({ code: 'transport_lost' });
        expect(f.frames).toEqual([]);
    });
    it('sends only the existing exec frame to the current isolated workload; nonzero remains internal', async () => {
        const f = fixture({
            driver: 'docker-gvisor',
            isolation: 'sandboxed-container',
        });
        expect(await f.run()).toMatchObject({
            exitCode: 9,
            stdout: 'internal check',
        });
        expect(f.frames).toHaveLength(1);
        expect(f.frames[0]).toMatchObject({
            type: 'exec',
            claimId: 'claim-a',
            body: { command: 'pnpm test' },
        });
        expect(f.frames[0].body).not.toHaveProperty('executionScope');
    });
});
