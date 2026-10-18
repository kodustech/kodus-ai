import {
    formatCustomAgentsSummary,
    summarizeCustomAgentRuns,
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
