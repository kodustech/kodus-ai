import { WorkflowJobConsumer } from './workflow-job-consumer.service';

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

describe('WorkflowJobConsumer task protection', () => {
    let calls: string[];
    let consumer: WorkflowJobConsumer;
    let jobs: Map<string, Deferred>;

    beforeEach(() => {
        calls = [];
        jobs = new Map();
        const taskProtectionService = {
            protectTask: jest.fn(async () => {
                calls.push('protect');
            }),
            unprotectTask: jest.fn(async () => {
                calls.push('unprotect');
            }),
        };
        consumer = new WorkflowJobConsumer(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            taskProtectionService as any,
        );
        jest.spyOn(consumer as any, 'processWorkflowJob').mockImplementation(
            (...args: any[]) =>
                jobs.get(args[2].jobId)!.promise,
        );
    });

    const run = (jobId: string) => {
        jobs.set(jobId, deferred());
        return (consumer as any).handleWorkflowJob(
            'consumer',
            'workflow.jobs.code_review.queue',
            { jobId },
            {},
        ) as Promise<void>;
    };

    it('keeps the task protected while another job is still running', async () => {
        const a = run('a');
        const b = run('b');
        await new Promise(setImmediate);

        jobs.get('a')!.resolve();
        await a;

        expect(calls).not.toContain('unprotect');

        jobs.get('b')!.resolve();
        await b;

        expect(calls[calls.length - 1]).toBe('unprotect');
        expect(calls.filter((c) => c === 'unprotect')).toHaveLength(1);
    });

    it('unprotects after the last job even when it fails', async () => {
        const a = run('a');
        await new Promise(setImmediate);
        (consumer as any).processWorkflowJob.mockRejectedValueOnce(
            new Error('boom'),
        );
        const b = run('b');
        await expect(b).rejects.toThrow('boom');
        expect(calls).not.toContain('unprotect');

        jobs.get('a')!.resolve();
        await a;
        expect(calls[calls.length - 1]).toBe('unprotect');
    });

    it('coalesces calls while the ECS agent is slow instead of queuing one per job', async () => {
        const gate = deferred();
        const svc = (consumer as any).taskProtectionService;
        svc.protectTask.mockImplementationOnce(async () => {
            await gate.promise;
            calls.push('protect');
        });

        const first = run('j0');
        await new Promise(setImmediate);
        // 20 more jobs arrive while the first protect is stuck at the agent
        const rest = Array.from({ length: 20 }, (_, i) => run(`j${i + 1}`));
        gate.resolve();
        await new Promise(setImmediate);

        // one in flight + one queued, not 21
        expect(svc.protectTask).toHaveBeenCalledTimes(2);

        for (const id of jobs.keys()) jobs.get(id)!.resolve();
        await Promise.all([first, ...rest]);
        expect(calls[calls.length - 1]).toBe('unprotect');
    });

    it('keeps refreshing protection as new jobs start on a busy worker', async () => {
        const svc = (consumer as any).taskProtectionService;
        const a = run('a');
        await new Promise(setImmediate);
        const b = run('b');
        await new Promise(setImmediate);
        const c = run('c');
        await new Promise(setImmediate);

        // every job start re-issues protect (refreshes the 60-min expiry)
        expect(svc.protectTask).toHaveBeenCalledTimes(3);

        for (const id of ['a', 'b', 'c']) jobs.get(id)!.resolve();
        await Promise.all([a, b, c]);
    });

    it('a rejected protection call does not stall the next one', async () => {
        const svc = (consumer as any).taskProtectionService;
        svc.protectTask.mockRejectedValueOnce(new Error('agent exploded'));

        const a = run('a');
        await new Promise(setImmediate);
        jobs.get('a')!.resolve();
        await a;

        expect(calls[calls.length - 1]).toBe('unprotect');
    });

    it('ends protected when a job starts while the previous unprotect is in flight', async () => {
        const gate = deferred();
        const svc = (consumer as any).taskProtectionService;
        svc.unprotectTask.mockImplementationOnce(async () => {
            await gate.promise;
            calls.push('unprotect');
        });

        const a = run('a');
        await new Promise(setImmediate);
        jobs.get('a')!.resolve();
        const aDone = a;
        await new Promise(setImmediate);

        // unprotect for "a" is stuck at the agent; "b" arrives meanwhile
        const b = run('b');
        gate.resolve();
        await aDone;
        await new Promise(setImmediate);

        expect(calls[calls.length - 1]).toBe('protect');

        jobs.get('b')!.resolve();
        await b;
        expect(calls[calls.length - 1]).toBe('unprotect');
    });
});
