// Kody Rules reposts where the developer answered the earlier comment and the
// judge found the answer incomplete. Invented code.
const lines = (...l) => l.join('\n') + '\n';

const skipCommentRule = {
    uuid: 'rule-comment-validation-skips',
    title: 'Comment early returns that skip validation',
    rule: 'Every early return in a validator is preceded by a comment that starts with "Skips:" and names the inputs that skip validation and the checks they skip. A comment without that prefix does not count.',
};

module.exports = [
    {
        id: 'P01-rule-skip-comment-incomplete',
        shape: 'Kody Rule on a file new in the PR; the developer answered with a comment that documents nothing; stored implemented; 15 earlier comments',
        agent: 'kody-rules',
        rule: skipCommentRule,
        base: {},
        head: {
            'src/shipping/address.schema.ts': lines(
                "import { z } from 'zod';",
                "import { POSTAL_PATTERNS } from './postal';",
                '',
                'export const addressSchema = z',
                '    .object({',
                '        country: z.string().length(2),',
                '        postalCode: z.string().trim(),',
                '        pickupPoint: z.boolean(),',
                '    })',
                '    .superRefine((value, ctx) => {',
                '        // early exit',
                '        if (value.pickupPoint) {',
                '            return;',
                '        }',
                '        const pattern = POSTAL_PATTERNS[value.country];',
                '        if (pattern && !pattern.test(value.postalCode)) {',
                "            ctx.addIssue({ code: 'custom', path: ['postalCode'], message: 'invalid postal code' });",
                '        }',
                '    });',
            ),
            'src/shipping/postal.ts': lines("export const POSTAL_PATTERNS: Record<string, RegExp> = { BR: /^\\d{5}-?\\d{3}$/, US: /^\\d{5}(-\\d{4})?$/ };"),
        },
        earlier: {
            file: 'src/shipping/address.schema.ts',
            lines: [11, 13],
            label: 'kody_rules',
            status: 'implemented',
            text: 'The superRefine returns early for pickup points without a "Skips:" comment, against the rule "Comment early returns that skip validation". Add one above the return, for example `// Skips: pickup points skip postal-code validation; every other address is validated against its country pattern.`',
        },
        historySize: 15,
        claims: [
            {
                id: 'skip-comment-repeat',
                at: { file: 'src/shipping/address.schema.ts', lines: [10, 14] },
                golden: 'The early return for pickup points has no comment starting with "Skips:" naming what it skips (the comment above it only says "early exit"), as the rule requires.',
                expect: 'not_deliver',
            },
        ],
    },
];
