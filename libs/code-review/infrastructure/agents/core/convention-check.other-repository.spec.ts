/**
 * A team keeps its rules in a separate repository and links them to a custom
 * agent as `owner/repo:path`. The quote gate must accept a finding that cites
 * one of them (as linked, or as models actually cite it), and still reject
 * everything it rejected before.
 * Fixture domain: an invented greenhouse-irrigation team and its rules repo.
 */
import type { FinderSuggestion } from '@libs/code-review/infrastructure/agents/core/finder.agent';
import { checkConventionQuotes } from '@libs/code-review/infrastructure/agents/core/convention-check';

const RULES_DOC = 'greenhouse/irrigation-rules:stack/node/rules/valves.md';
const RULES_SKILL =
    'greenhouse/irrigation-rules:stack/node/skills/migrations/SKILL.md';
const RULES_TEXT = `# Valve rules

Every valve handler must log the zone id before it opens a valve.
`;
const SKILL_REFERENCE =
    'greenhouse/irrigation-rules:stack/node/skills/migrations/references/locks.md';
const SKILL_REFERENCE_TEXT = `# Locks

A migration never holds a table lock for longer than one statement.
`;

const files: Record<string, string> = {
    [RULES_DOC]: RULES_TEXT,
    [RULES_SKILL]: '---\nname: migrations\ndescription: x\n---\n# Migrations\n',
    [SKILL_REFERENCE]: SKILL_REFERENCE_TEXT,
};
const readGuide = async (file: string) => files[file] ?? null;
const guides = [RULES_DOC, RULES_SKILL];

function cites(file: string, quote: string): FinderSuggestion {
    return {
        relevantFile: 'src/valves/open-valve.handler.ts',
        suggestionContent: 'The handler opens the valve without logging.',
        existingCode: 'await valve.open();',
        improvedCode: 'logger.info({ zoneId }); await valve.open();',
        kind: 'convention',
        source: { file, section: 'Valve rules', quote },
    };
}

const QUOTE =
    'Every valve handler must log the zone id before it opens a valve.';

describe('quote gate with a guide of another repository', () => {
    it.each([
        ['as linked', RULES_DOC],
        ['as repo/path', 'irrigation-rules/stack/node/rules/valves.md'],
        [
            'as owner/repo/path',
            'greenhouse/irrigation-rules/stack/node/rules/valves.md',
        ],
        ['as the bare path', 'stack/node/rules/valves.md'],
    ])(
        'passes a finding that cites it %s, re-pointed at the linked guide',
        async (_how, file) => {
            const result = await checkConventionQuotes(
                [cites(file, QUOTE)],
                readGuide,
                guides,
            );

            expect(result.rejected).toEqual([]);
            expect(result.passed).toHaveLength(1);
            expect(result.passed[0].finding.source?.file).toBe(RULES_DOC);
        },
    );

    it('passes a quote from a file beside a linked SKILL.md of that repository', async () => {
        const result = await checkConventionQuotes(
            [
                cites(
                    'irrigation-rules/stack/node/skills/migrations/references/locks.md',
                    'A migration never holds a table lock for longer than one statement.',
                ),
            ],
            readGuide,
            guides,
        );

        expect(result.passed.map((p) => p.finding.source?.file)).toEqual([
            SKILL_REFERENCE,
        ]);
    });

    it('still rejects a quote that is not in the linked guide', async () => {
        const result = await checkConventionQuotes(
            [
                cites(
                    RULES_DOC,
                    'Every valve handler must retry three times before failing.',
                ),
            ],
            readGuide,
            guides,
        );

        expect(result.passed).toEqual([]);
        expect(result.rejected[0].detail).toContain('quote not found');
    });

    it('still rejects a file that is not linked, in that repository or any other', async () => {
        const result = await checkConventionQuotes(
            [
                cites(
                    'greenhouse/irrigation-rules:stack/node/rules/other.md',
                    QUOTE,
                ),
                cites('src/valves/open-valve.handler.ts', QUOTE),
            ],
            async () => RULES_TEXT,
            guides,
        );

        expect(result.passed).toEqual([]);
        expect(result.rejected.map((r) => r.detail)).toEqual([
            'greenhouse/irrigation-rules:stack/node/rules/other.md is not a guide linked to this review',
            'src/valves/open-valve.handler.ts is not a guide linked to this review',
        ]);
    });

    it('does not guess when a bare path names guides of two repositories', async () => {
        const twin = 'greenhouse/pump-rules:stack/node/rules/valves.md';
        const result = await checkConventionQuotes(
            [cites('stack/node/rules/valves.md', QUOTE)],
            async () => RULES_TEXT,
            [RULES_DOC, twin],
        );

        expect(result.passed).toEqual([]);
        expect(result.rejected[0].detail).toBe(
            'stack/node/rules/valves.md is not a guide linked to this review',
        );
    });
});
