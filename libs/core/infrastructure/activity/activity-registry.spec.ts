import {
    activityCounts,
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

    it('keeps two runs of the same job apart', async () => {
        let release!: () => void;
        const second = runActivity('job-x', {}, async () => {
            updateActivity({ stage: 'second' });
            await new Promise<void>((r) => (release = r));
        });
        await runActivity('job-x', {}, async () => {
            updateActivity({ stage: 'first' });
        });
        // The first run ended: the second run's entry is still there.
        expect(activitySnapshot()).toEqual([
            expect.objectContaining({ jobId: 'job-x', stage: 'second' }),
        ]);
        release();
        await second;
        expect(activitySnapshot()).toEqual([]);
    });

    it('keeps the oldest tool calls when more are in flight than it shows', async () => {
        await runActivity('job', {}, async () => {
            for (let i = 0; i < 12; i++) beginToolActivity(`tool-${i}`);
            const tools = activitySnapshot()[0].tools!;
            expect(tools[0].tool).toBe('tool-0');
            expect(tools.map((t) => t.tool)).not.toContain('tool-11');
        });
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

    it('counts every job in flight by type and sums the size of the reviews', async () => {
        const release: Array<() => void> = [];
        const hold = () => new Promise<void>((r) => release.push(r));
        const jobs = [
            runActivity('r1', {}, async () => {
                updateActivity({
                    workflowType: 'CODE_REVIEW',
                    changedFiles: 10,
                    changedLines: 400,
                });
                await hold();
            }),
            runActivity('r2', {}, async () => {
                updateActivity({
                    workflowType: 'CODE_REVIEW',
                    changedFiles: 3,
                });
                await hold();
            }),
            // A review whose provider sends no size is counted, not sized.
            runActivity('r3', {}, async () => {
                updateActivity({ workflowType: 'CODE_REVIEW' });
                await hold();
            }),
            // A PR with no changed files has a known size of 0.
            runActivity('r4', {}, async () => {
                updateActivity({
                    workflowType: 'CODE_REVIEW',
                    changedFiles: 0,
                });
                await hold();
            }),
            runActivity('w1', {}, async () => {
                updateActivity({ workflowType: 'WEBHOOK_PROCESSING' });
                await hold();
            }),
        ];
        await tick();
        const counts = activityCounts();
        release.forEach((r) => r());
        await Promise.all(jobs);

        expect(counts).toEqual({
            total: 5,
            byWorkflowType: { CODE_REVIEW: 4, WEBHOOK_PROCESSING: 1 },
            reviews: {
                withSize: 3,
                changedFilesSum: 13,
                changedFilesMax: 10,
                changedLinesSum: 400,
            },
        });
        expect(activityCounts().total).toBe(0);
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
