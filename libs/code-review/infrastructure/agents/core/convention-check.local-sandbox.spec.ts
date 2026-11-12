/**
 * Self-hosted reviews run on the local sandbox, whose command channel refuses
 * git. A custom agent's finding that quotes a guide of the reviewed repository
 * must still pass the quote gate, read from the target branch the same way
 * the guide was loaded, and the gate must still reject what it rejected
 * before.
 * Fixture domain: an invented tram-depot team and its maintenance skill.
 */
import type { FinderSuggestion } from '@libs/code-review/infrastructure/agents/core/finder.agent';
import {
    checkConventionQuotes,
    guideSourcesFor,
    makeTargetBranchGuideLister,
    makeTargetBranchGuideReader,
} from '@libs/code-review/infrastructure/agents/core/convention-check';

const SKILL = '.skills/maintenance/SKILL.md';
const SKILL_TEXT = `---
name: maintenance
description: How depot jobs book a tram for maintenance.
---

# Maintenance

- A job books a tram only after checking that the tram is parked in the depot.
`;
const REFERENCE = '.skills/maintenance/references/brakes.md';
const REFERENCE_TEXT = `# Brakes

Brake tests are recorded before the tram leaves the bay.
`;

// What the base branch holds, as the knowledge reader reads it.
const onTarget: Record<string, string> = {
    [SKILL]: SKILL_TEXT,
    [REFERENCE]: REFERENCE_TEXT,
};
const knowledgeReader = {
    readFile: async (path: string) =>
        path in onTarget
            ? { status: 'ok' as const, content: onTarget[path] }
            : { status: 'missing' as const },
    listFiles: async (dir: string) =>
        Object.keys(onTarget).filter((p) => p.startsWith(`${dir}/`)),
};

// The local sandbox's command channel: every git command is refused.
const refusesGit = {
    exec: async (command: string) => ({
        stdout: `Program "${command.split(' ')[0]}" is not allowed in local sandbox. Allowed: sg, ast-grep, cat, wc, head, tail, file, fd, find, grep`,
        stderr: '',
        exitCode: 1,
    }),
};

function cites(file: string, quote: string): FinderSuggestion {
    return {
        relevantFile: 'src/jobs/book-tram.ts',
        suggestionContent:
            'The job books the tram without checking where it is parked.',
        existingCode: 'await bookings.create(tramId);',
        improvedCode:
            'await assertParkedInDepot(tramId);\nawait bookings.create(tramId);',
        kind: 'convention',
        source: { file, section: 'Maintenance', quote },
    };
}

// The quote gate as a local-sandbox review builds it: the sandbox's
// target-branch reads, then the knowledge reader.
async function gate(
    finding: FinderSuggestion,
    guides = [SKILL],
    commands: { exec: (command: string) => Promise<unknown> } = refusesGit,
) {
    const sources = guideSourcesFor(
        guides,
        knowledgeReader,
        makeTargetBranchGuideReader(commands as never, 'main'),
        makeTargetBranchGuideLister(commands as never, 'main'),
    );
    if (!sources) throw new Error('no guide sources for a review with guides');
    return checkConventionQuotes(
        [finding],
        sources.readGuide,
        guides,
        sources.listGuideDir,
    );
}

describe('quote gate on the local sandbox', () => {
    it('passes a finding that quotes a linked skill of the reviewed repository', async () => {
        const result = await gate(
            cites(
                SKILL,
                'A job books a tram only after checking that the tram is parked in the depot.',
            ),
        );

        expect(result.rejected).toEqual([]);
        expect(result.passed).toHaveLength(1);
    });

    it('passes a quote from a file beside the linked SKILL.md', async () => {
        const result = await gate(
            cites(
                REFERENCE,
                'Brake tests are recorded before the tram leaves the bay.',
            ),
        );

        expect(result.rejected).toEqual([]);
        expect(result.passed).toHaveLength(1);
    });

    // A command that times out, or a sandbox that died mid-review, rejects
    // instead of returning a non-zero exit.
    it('passes the quote when the sandbox read fails outright', async () => {
        const sandboxDown = {
            exec: async () => {
                throw new Error('command timed out');
            },
        };

        const result = await gate(
            cites(
                SKILL,
                'A job books a tram only after checking that the tram is parked in the depot.',
            ),
            [SKILL],
            sandboxDown,
        );

        expect(result.rejected).toEqual([]);
        expect(result.passed).toHaveLength(1);
    });

    it('still rejects a quote that is not in the skill', async () => {
        const result = await gate(
            cites(SKILL, 'A job may book any tram that is not in service.'),
        );

        expect(result.passed).toEqual([]);
        expect(result.rejected).toHaveLength(1);
    });

    it('still rejects a linked skill the target branch does not have', async () => {
        const missing = '.skills/timetable/SKILL.md';
        const result = await gate(
            cites(missing, 'Timetables are published a week ahead.'),
            [missing],
        );

        expect(result.passed).toEqual([]);
        expect(result.rejected).toEqual([
            expect.objectContaining({
                detail: `${missing} not found on the target branch`,
            }),
        ]);
    });
});
