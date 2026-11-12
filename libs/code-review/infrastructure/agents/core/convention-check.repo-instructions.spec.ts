/**
 * A team keeps its conventions in the repository's coding-agent instruction
 * files (CLAUDE.md, AGENTS.md) and turned on repository instructions, so the
 * review loads those files from the target branch and hands them to every
 * agent. A custom agent's finding that quotes a rule from one of them must
 * pass the quote gate; a quote that is not in the file, or a file the review
 * did not load, is still rejected.
 * Fixture domain: an invented bike-rental team.
 */
import type { FinderSuggestion } from '@libs/code-review/infrastructure/agents/core/finder.agent';
import { checkConventionQuotes } from '@libs/code-review/infrastructure/agents/core/convention-check';

const RULE =
    'Rental prices are computed by PricingService; controllers never apply discounts themselves.';
const ROOT_INSTRUCTIONS = {
    path: 'CLAUDE.md',
    content: `# Working in this repository

## Pricing

- ${RULE}
- Prices are integer cents.
`,
};
const PACKAGE_INSTRUCTIONS = {
    path: 'packages/bikes/AGENTS.md',
    content: `# Bikes package

- A bike is retired only through RetireBike, which also closes its open rentals.
`,
};
const loaded = [ROOT_INSTRUCTIONS, PACKAGE_INSTRUCTIONS];

// No guide is linked to the agent: nothing is read from a guide.
const readGuide = async () => null;

function cites(file: string, quote: string): FinderSuggestion {
    return {
        relevantFile: 'src/rentals/rentals.controller.ts',
        suggestionContent:
            'The controller takes 10% off the price itself instead of asking PricingService.',
        existingCode: 'price = Math.floor(price * 0.9);',
        improvedCode: 'price = await pricing.priceFor(rental);',
        kind: 'convention',
        source: { file, section: 'Pricing', quote },
    };
}

async function gate(finding: FinderSuggestion, instructionFiles = loaded) {
    return checkConventionQuotes(
        [finding],
        readGuide,
        [],
        undefined,
        undefined,
        instructionFiles,
    );
}

describe('quote gate with repository instruction files', () => {
    it.each([
        ['as loaded', 'CLAUDE.md'],
        ['with a leading ./', './CLAUDE.md'],
    ])(
        'passes a finding that quotes a loaded instruction file, cited %s',
        async (_how, file) => {
            const result = await gate(cites(file, RULE));

            expect(result.rejected).toEqual([]);
            expect(result.passed).toHaveLength(1);
            expect(result.passed[0].finding.source?.file).toBe('CLAUDE.md');
        },
    );

    it('passes a quote from a nested instruction file the review loaded', async () => {
        const result = await gate(
            cites(
                'packages/bikes/AGENTS.md',
                'A bike is retired only through RetireBike, which also closes its open rentals.',
            ),
        );

        expect(result.rejected).toEqual([]);
        expect(result.passed).toHaveLength(1);
    });

    it('still rejects a quote that is not in the instruction file', async () => {
        const result = await gate(
            cites(
                'CLAUDE.md',
                'Controllers may apply any discount the sales team approves.',
            ),
        );

        expect(result.passed).toEqual([]);
        expect(result.rejected).toHaveLength(1);
    });

    it('still rejects an instruction file the review did not load', async () => {
        const result = await gate(cites('docs/pricing.md', RULE));

        expect(result.passed).toEqual([]);
        expect(result.rejected).toEqual([
            expect.objectContaining({
                detail: 'docs/pricing.md is not a guide linked to this review',
            }),
        ]);
    });

    it('still rejects every unlinked file when repository instructions are off', async () => {
        const result = await gate(cites('CLAUDE.md', RULE), []);

        expect(result.passed).toEqual([]);
        expect(result.rejected).toEqual([
            expect.objectContaining({
                detail: 'CLAUDE.md is not a guide linked to this review',
            }),
        ]);
    });
});
