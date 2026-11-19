import {
    activitySnapshot,
    beginToolActivity,
    onActivityChange,
    runActivity,
    updateActivity,
} from './activity-registry';

const tick = () => new Promise((r) => setImmediate(r));

describe('activity registry', () => {
    afterEach(() => onActivityChange(null));

    it('tracks a job from start to end, with its stage, PR and tool in flight', async () => {
        let seen: ReturnType<typeof activitySnapshot> = [];
        await runActivity('job-1', { queue: 'q' }, async () => {
            updateActivity({
                stage: 'AgentReviewStage',
                organizationId: 'org',
                repository: 'repo',
                prNumber: 42,
            });
            const end = beginToolActivity('grep', 'pattern=foo path=.');
            seen = activitySnapshot();
            end();
        });
        expect(seen).toEqual([
            expect.objectContaining({
                jobId: 'job-1',
                queue: 'q',
                stage: 'AgentReviewStage',
                organizationId: 'org',
                repository: 'repo',
                prNumber: 42,
                tools: [
                    expect.objectContaining({
                        tool: 'grep',
                        args: 'pattern=foo path=.',
                    }),
                ],
            }),
        ]);
        expect(activitySnapshot()).toEqual([]);
    });

    it('keeps concurrent jobs apart through async calls', async () => {
        let a: any;
        let b: any;
        await Promise.all([
            runActivity('a', {}, async () => {
                await tick();
                updateActivity({ prNumber: 1 });
                await tick();
                a = activitySnapshot().find((x) => x.jobId === 'a');
            }),
            runActivity('b', {}, async () => {
                updateActivity({ prNumber: 2 });
                await tick();
                b = activitySnapshot().find((x) => x.jobId === 'b');
            }),
        ]);
        expect(a.prNumber).toBe(1);
        expect(b.prNumber).toBe(2);
    });

    it('is a no-op outside a job', () => {
        updateActivity({ stage: 'x' });
        const end = beginToolActivity('grep');
        end();
        expect(activitySnapshot()).toEqual([]);
    });

    it('removes the entry even when the job throws', async () => {
        await expect(
            runActivity('boom', {}, async () => {
                throw new Error('fail');
            }),
        ).rejects.toThrow('fail');
        expect(activitySnapshot()).toEqual([]);
    });

    it('notifies the listener before synchronous work that follows an await', async () => {
        const snaps: ReturnType<typeof activitySnapshot>[] = [];
        onActivityChange((s) => snaps.push(s));
        await runActivity('job', {}, async () => {
            const end = beginToolActivity('grep', 'x');
            await Promise.resolve(); // the tool's own await
            // A synchronous freeze would start here: the snapshot with the
            // tool in flight has already been delivered.
            expect(snaps.some((s) => s[0]?.tools?.[0]?.tool === 'grep')).toBe(
                true,
            );
            end();
        });
    });

    it('bounds the text it keeps', async () => {
        await runActivity('job', {}, async () => {
            updateActivity({ repository: 'r'.repeat(10_000) });
            beginToolActivity('grep', 'p'.repeat(10_000));
            const s = activitySnapshot()[0];
            expect(s.repository!.length).toBeLessThanOrEqual(300);
            expect(s.tools![0].args!.length).toBeLessThanOrEqual(300);
        });
    });
});
