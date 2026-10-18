import {
    formatCustomAgentsSummary,
    summarizeCustomAgentRuns,
    withDeliveredCounts,
} from './custom-agent-summary';

const run = (status: any = 'no-matching-files') => ({
    id: 'tf',
    name: 'Terraform',
    slug: 'terraform',
    status,
    droppedByVerify: 0,
});

const agent = {
    id: 'tf',
    scope: { include: ['infra/**/*.tf'], exclude: [] },
};

describe('summarizeCustomAgentRuns — ignored paths', () => {
    it('says the files were ignored when only ignored files were in scope', () => {
        const [summary] = summarizeCustomAgentRuns([run()], [], {
            agents: [agent],
            ignoredFiles: ['infra/envs/prod/main.tf', 'README.md'],
        });
        expect(summary.status).toBe('ignored-paths');
        expect(formatCustomAgentsSummary([summary])).toContain(
            'not run: its files are in the ignored paths',
        );
    });

    it('keeps "no matching files" when nothing ignored was in scope', () => {
        const [summary] = summarizeCustomAgentRuns([run()], [], {
            agents: [agent],
            ignoredFiles: ['README.md'],
        });
        expect(summary.status).toBe('no-matching-files');
    });

    it('leaves an agent that ran alone', () => {
        const [summary] = summarizeCustomAgentRuns([run('ran')], [], {
            agents: [agent],
            ignoredFiles: ['infra/envs/prod/main.tf'],
        });
        expect(summary.status).toBe('ran');
    });
});

describe('withDeliveredCounts', () => {
    const summary = (id: string, posted: number) => ({
        id,
        name: id,
        slug: id,
        status: 'ran' as const,
        droppedByVerify: 0,
        posted,
    });
    const result = (agentId: string, deliveryStatus: string) => ({
        comment: { suggestion: { customAgent: { id: agentId } } },
        deliveryStatus,
    });

    it('counts only the inline comments that reached the pull request', () => {
        // The provider refused to create content: every post failed, yet the
        // table said 8 posted next to "no issues found".
        const [run] = withDeliveredCounts(
            [summary('inputs', 3)],
            [
                result('inputs', 'sent'),
                result('inputs', 'failed'),
                result('inputs', 'failed'),
            ] as any,
            [],
        );
        expect(run.posted).toBe(1);
    });

    it("counts a single-comment agent's findings only when its comment was sent", () => {
        const runs = [summary('one', 4), summary('two', 2)];
        const out = withDeliveredCounts(runs, [], [
            result('one', 'sent'),
            result('two', 'failed'),
        ] as any);
        expect(out.map((r) => r.posted)).toEqual([4, 0]);
    });

    it('keeps the counts when nothing was posted at all', () => {
        const out = withDeliveredCounts(
            [summary('a', 2)],
            undefined,
            undefined,
        );
        expect(out[0].posted).toBe(2);
    });
});
