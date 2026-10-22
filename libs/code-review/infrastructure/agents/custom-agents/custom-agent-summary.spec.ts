import { summarizeCustomAgentRuns } from './custom-agent-summary';

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

describe('summarizeCustomAgentRuns — kept findings', () => {
    it("counts each agent's findings that will post", () => {
        const [summary] = summarizeCustomAgentRuns([run('ran')], [
            { customAgent: { id: 'tf' } },
            { customAgent: { id: 'tf' } },
            { customAgent: { id: 'other' } },
            {},
        ] as any);
        expect(summary).toMatchObject({ status: 'ran', posted: 2 });
    });
});
