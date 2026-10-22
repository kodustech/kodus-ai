const { buildCases, DECOY, CASE_SETS, casesFor } = require('./cases');

// Each case is a real merged PR reviewed by production's stage
// (evals/investigation/agent-provider.js): the platform's data for the PR,
// and a CLAUDE.md on its target branch stating the convention it breaks.
describe('repo-instructions cases', () => {
    const cases = buildCases();
    const source = require('../kody-rules/github-cases.json');

    it('builds one case per Kody Rules case with recorded PR data', () => {
        expect(cases.length).toBe(
            source.filter((c: { pr?: unknown }) => c.pr).length,
        );
        expect(cases.length).toBeGreaterThan(0);
    });

    it("gives production's review the PR as the platform returns it", () => {
        const c = cases[0];
        const pr = source.find(
            (s: { caseId: string }) =>
                `repo-instructions:${s.caseId}` === c.caseId,
        ).pr;
        expect(c.vars).toMatchObject({
            repositoryFullName: pr.repositoryFullName,
            prNumber: pr.number,
            prHead: { ref: pr.headRef, sha: pr.headSha },
            prBase: { ref: pr.baseRef, sha: pr.baseSha },
            prFiles: pr.files,
            prCommits: pr.commits,
        });
    });

    it('puts a CLAUDE.md with the convention and the decoy on the target branch', () => {
        const [file] = cases[0].vars.repoInstructions.files;
        expect(file.path).toBe('CLAUDE.md');
        expect(file.content).toContain(cases[0].convention);
        expect(file.content).toContain(DECOY);
    });
});

describe('repo-instructions sets', () => {
    const ids = buildCases().map((c: { caseId: string }) => c.caseId);

    it('names a controlled set of existing cases, each with violation lines', () => {
        expect(CASE_SETS.controlled).toHaveLength(7);
        for (const id of CASE_SETS.controlled) {
            expect(ids).toContain(`repo-instructions:${id}`);
        }
        const controlled = casesFor('controlled');
        expect(controlled).toHaveLength(7);
        for (const c of controlled) {
            expect(
                Object.values(c.groundTruth as Record<string, unknown[]>).flat()
                    .length,
            ).toBeGreaterThan(0);
        }
    });

    it('runs every case on the full set', () => {
        expect(casesFor('full')).toHaveLength(ids.length);
    });
});
