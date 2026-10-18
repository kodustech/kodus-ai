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
            'Not run: Terraform (its files are in the ignored paths)',
        );
    });

    it('keeps "no matching files" when nothing ignored was in scope', () => {
        const [summary] = summarizeCustomAgentRuns([run()], [], {
            agents: [agent],
            ignoredFiles: ['README.md'],
        });
        expect(summary.status).toBe('no-matching-files');
    });

    it('says the files were deleted when only deleted files were in scope', () => {
        const [summary] = summarizeCustomAgentRuns([run()], [], {
            agents: [agent],
            ignoredFiles: ['infra/envs/prod/main.tf'],
            removedFiles: ['infra/envs/prod/main.tf'],
        });
        expect(summary.status).toBe('deleted-files');
        const table = formatCustomAgentsSummary([summary]);
        expect(table).toContain('Not run: Terraform (its files were deleted)');
        expect(table).not.toContain('ignored paths');
    });

    it('still says ignored when an ignored file in scope was not deleted', () => {
        const [summary] = summarizeCustomAgentRuns([run()], [], {
            agents: [agent],
            ignoredFiles: ['infra/a.tf', 'infra/b.tf'],
            removedFiles: ['infra/a.tf'],
        });
        expect(summary.status).toBe('ignored-paths');
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

describe('formatCustomAgentsSummary — agents that did not run', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
        id: `a${i}`,
        name: `Agent ${i}`,
        slug: `agent-${i}`,
        status: (i < 2
            ? 'ran'
            : i < 27
              ? 'no-matching-files'
              : i < 29
                ? 'ignored-paths'
                : 'failed') as any,
        droppedByVerify: 0,
        posted: i < 2 ? 1 : 0,
    }));

    it('keeps rows for the agents that ran or failed and one line per reason for the rest', () => {
        const markdown = formatCustomAgentsSummary(many);
        const rows = markdown.split('\n').filter((l) => /^\| Agent \d/.test(l));

        expect(rows).toHaveLength(3);
        expect(markdown).toContain('| Agent 29 | failed |');
        expect(markdown).toContain(
            `Not run: ${Array.from({ length: 25 }, (_, i) => `Agent ${i + 2}`).join(', ')} (no matching files)`,
        );
        expect(markdown).toContain(
            'Not run: Agent 27, Agent 28 (its files are in the ignored paths)',
        );
    });

    it('drops the table when no agent ran', () => {
        const markdown = formatCustomAgentsSummary([many[5]]);

        expect(markdown).not.toContain('| Agent | Status');
        expect(markdown).toContain('Not run: Agent 5 (no matching files)');
    });
});
