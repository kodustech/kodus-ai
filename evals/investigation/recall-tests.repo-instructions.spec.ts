import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const buildTests = require('./recall-tests');

const CASE_WITH =
    'add-guest-management-functionality-to-existing-bookings-cal-com';
const CASE_WITHOUT = 'feat-2fa-backup-codes-cal-com';

const instructions = {
    files: [
        {
            path: 'AGENTS.md',
            content: 'Use the repository logger.',
            appliesTo: '**',
            truncated: false,
        },
    ],
    otherFiles: [],
    dropped: [],
    truncated: false,
    indexedCount: 1,
};

describe('recall-tests — RECALL_REPO_INSTRUCTIONS', () => {
    const env = { ...process.env };
    let file: string;

    beforeEach(() => {
        file = path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), 'recall-instr-')),
            'instructions.json',
        );
        fs.writeFileSync(
            file,
            JSON.stringify({
                [CASE_WITH]: { repoInstructions: instructions },
                [CASE_WITHOUT]: {
                    repoInstructions: { ...instructions, files: [] },
                },
            }),
        );
        process.env.RECALL_CASES = `${CASE_WITH},${CASE_WITHOUT}`;
    });

    afterEach(() => {
        process.env = { ...env };
    });

    const byCase = async () =>
        Object.fromEntries(
            (await buildTests()).map((t: { vars: { caseId: string } }) => [
                t.vars.caseId,
                t.vars,
            ]),
        );

    it('gives each case the instructions recorded for it', async () => {
        process.env.RECALL_REPO_INSTRUCTIONS = file;

        const vars = await byCase();

        expect(vars[CASE_WITH].repoInstructions).toEqual(instructions);
        expect(vars[CASE_WITHOUT].repoInstructions).toBeUndefined();
    });

    it("gives a case the target branch's instruction files when they were recorded", async () => {
        const targetBranchFiles = {
            'CLAUDE.md': 'AI-AGENTS.md',
            'AI-AGENTS.md': 'Use the repository logger.',
        };
        fs.writeFileSync(
            file,
            JSON.stringify({
                [CASE_WITH]: {
                    repoInstructions: instructions,
                    targetBranchFiles,
                },
            }),
        );
        process.env.RECALL_REPO_INSTRUCTIONS = file;

        const vars = await byCase();

        expect(vars[CASE_WITH].targetBranchFiles).toEqual(targetBranchFiles);
    });

    it('leaves every case without instructions when unset', async () => {
        delete process.env.RECALL_REPO_INSTRUCTIONS;

        const vars = await byCase();

        expect(vars[CASE_WITH].repoInstructions).toBeUndefined();
    });

    it('fails loudly when the file cannot be read', async () => {
        process.env.RECALL_REPO_INSTRUCTIONS = `${file}.missing`;

        await expect(buildTests()).rejects.toThrow(/RECALL_REPO_INSTRUCTIONS/);
    });
});
