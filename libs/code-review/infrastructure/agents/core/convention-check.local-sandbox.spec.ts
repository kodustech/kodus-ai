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

function localSandboxSources() {
    return guideSourcesFor(
        [SKILL],
        knowledgeReader,
        makeTargetBranchGuideReader(refusesGit as never, 'main'),
        makeTargetBranchGuideLister(refusesGit as never, 'main'),
    );
}

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

describe('quote gate on the local sandbox', () => {
    it('passes a finding that quotes a linked skill of the reviewed repository', async () => {
        const sources = localSandboxSources();
        const result = await checkConventionQuotes(
            [
                cites(
                    SKILL,
                    'A job books a tram only after checking that the tram is parked in the depot.',
                ),
            ],
            sources!.readGuide,
            [SKILL],
            sources!.listGuideDir,
        );

        expect(result.rejected).toEqual([]);
        expect(result.passed).toHaveLength(1);
    });

    it('passes a quote from a file beside the linked SKILL.md', async () => {
        const sources = localSandboxSources();
        const result = await checkConventionQuotes(
            [
                cites(
                    REFERENCE,
                    'Brake tests are recorded before the tram leaves the bay.',
                ),
            ],
            sources!.readGuide,
            [SKILL],
            sources!.listGuideDir,
        );

        expect(result.rejected).toEqual([]);
        expect(result.passed).toHaveLength(1);
    });

    it('still rejects a quote that is not in the skill', async () => {
        const sources = localSandboxSources();
        const result = await checkConventionQuotes(
            [cites(SKILL, 'A job may book any tram that is not in service.')],
            sources!.readGuide,
            [SKILL],
            sources!.listGuideDir,
        );

        expect(result.passed).toEqual([]);
        expect(result.rejected).toHaveLength(1);
    });

    it('still rejects a linked skill the target branch does not have', async () => {
        const missing = '.skills/timetable/SKILL.md';
        const sources = guideSourcesFor(
            [missing],
            knowledgeReader,
            makeTargetBranchGuideReader(refusesGit as never, 'main'),
            makeTargetBranchGuideLister(refusesGit as never, 'main'),
        );
        const result = await checkConventionQuotes(
            [cites(missing, 'Timetables are published a week ahead.')],
            sources!.readGuide,
            [missing],
            sources!.listGuideDir,
        );

        expect(result.passed).toEqual([]);
        expect(result.rejected).toEqual([
            expect.objectContaining({
                detail: `${missing} not found on the target branch`,
            }),
        ]);
    });
});
