import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';

import {
    checkGlobPatternSyntax,
    checkIgnorePattern,
} from '../../../apps/web/src/core/utils/ignore-paths/validate-glob-pattern';

describe('checkGlobPatternSyntax', () => {
    describe('rejects unclosed constructs', () => {
        const INVALID = [
            '[abc',
            '**/[Bbuild/**',
            'src/[a-z/**',
            '{a,b',
            '**/*.{ts,tsx',
            '{a,{b,c}',
            '+(a',
            '!(foo.js',
            '**/*.@(png|jpg',
        ];

        it.each(INVALID)('rejects %j', (pattern) => {
            const result = checkGlobPatternSyntax(pattern);

            expect(result.valid).toBe(false);
            expect((result as { message: string }).message).toMatch(
                /Missing closing/,
            );
        });
    });

    describe('accepts well-formed patterns', () => {
        const VALID = [
            'yarn.lock',
            '**/*.json',
            '**/dist/**',
            'src/[Bb]uild/**',
            '**/*.{ts,tsx}',
            '**/*.@(png|jpg)',
            '+(a|b).js',
            '!(foo).js',
            '**/*.min.*',
            '[]]',
            'a[[]b',
            'a]b',
            'a}b',
            'a)b',
            '**/[[:alpha:]]*',
            '{a,{b,c}}',
            // Next.js-shaped paths users really type.
            'app/(dashboard)/**',
            'src/[id]/page.tsx',
            '**/[...slug]/*.ts',
            'docs/file (1).md',
            '!src/**',
        ];

        it.each(VALID)('accepts %j', (pattern) => {
            expect(checkGlobPatternSyntax(pattern)).toEqual({ valid: true });
        });
    });

    it('asks for input instead of reporting a syntax error on empty', () => {
        for (const blank of ['', '   ']) {
            const result = checkGlobPatternSyntax(blank);

            expect(result.valid).toBe(false);
            expect((result as { message: string }).message).toBe(
                'Type a pattern to add it.',
            );
        }
    });

    it('trims before checking', () => {
        expect(checkGlobPatternSyntax('  **/*.ts  ')).toEqual({ valid: true });
        expect(checkGlobPatternSyntax('  [abc  ').valid).toBe(false);
    });

    // picomatch's strictBrackets also rejects an unmatched CLOSING bracket or
    // paren, but the matcher treats those as literal text and ignores exactly
    // the file the user meant — flagging them would be a false alarm about a
    // pattern that works.
    it('accepts an unmatched closing bracket or paren', () => {
        for (const pattern of ['a]b', 'a)b', 'report]final.txt']) {
            expect([pattern, checkGlobPatternSyntax(pattern)]).toEqual([
                pattern,
                { valid: true },
            ]);
        }
    });

    // The check answers "is this syntactically a glob", NOT "will this match
    // anything". This pins that boundary so nobody later reads a green tick as
    // a promise the pattern is useful.
    it('accepts syntactically valid patterns that match nothing useful', () => {
        for (const pattern of ['**/ / / / / 6 5 8', '**/????????????????']) {
            expect(checkGlobPatternSyntax(pattern)).toEqual({ valid: true });
        }
    });

    // A false positive here would block a user from re-adding a pattern we
    // ship by default, so run the gnarliest ones from the shipped list.
    it('accepts the hairiest patterns shipped as defaults', () => {
        const defaults = [
            '**/[Dd]esktop.ini',
            '**/$RECYCLE.BIN/**',
            '**/*.sfd-*',
            '**/*.?Q?',
            '**/*.??_',
            '**/[Tt]est[Rr]esult*/**',
            '**/*- [Bb]ackup ([0-9]).rdl',
            '**/*- [Bb]ackup ([0-9][0-9]).rdl',
            '**/[._]*.s[a-v][a-z]',
            '**/Generated\\ Files/**',
            '**/*.hei[cf]',
            '**/*.m4[apv]',
            '**/[Ww][Ii][Nn]32/**',
            '**/*.i*86',
            '**/[._]s[a-rt-v][a-z]',
            '**/*.[Rr]e[Ss]harper',
            '**/.*crunch*.local.xml',
            '**/*/*/production',
        ];

        for (const pattern of defaults) {
            expect([pattern, checkGlobPatternSyntax(pattern)]).toEqual([
                pattern,
                { valid: true },
            ]);
        }
    });
});

describe('checkIgnorePattern', () => {
    it('carries the syntax verdict through', () => {
        expect(checkIgnorePattern('**/*.{ts,tsx}')).toEqual({ valid: true });
        expect(checkIgnorePattern('**/[Bbuild/**').valid).toBe(false);
        expect(checkIgnorePattern('  ').valid).toBe(false);
    });

    // The list is an OR over independently-compiled matchers with no ordered
    // re-inclusion, so "!" inverts instead of un-ignoring: `!src/**` matches
    // every file OUTSIDE src/ and drops nearly the whole repo from review.
    it.each(['!src/**', '!**/*.json', '!dist', '!!weird'])(
        'rejects the negation %j',
        (pattern) => {
            const result = checkIgnorePattern(pattern);

            expect(result.valid).toBe(false);
            expect((result as { message: string }).message).toMatch(
                /Negated patterns are not supported/,
            );
        },
    );

    // `!(...)` is an extglob matching a single segment, not a whole-tree
    // negation — rejecting it on a bare startsWith("!") would be a false alarm.
    it.each(['!(foo).js', '**/!(foo).js', '!(a|b)/**'])(
        'accepts the extglob %j',
        (pattern) => {
            expect(checkIgnorePattern(pattern)).toEqual({ valid: true });
        },
    );

    it('keeps the negation rule out of the syntax check', () => {
        // `!src/**` really is valid glob syntax; only this list rejects it.
        expect(checkGlobPatternSyntax('!src/**')).toEqual({ valid: true });
    });

    it('accepts every pattern shipped as a default', () => {
        const patterns: string[] = (getDefaultKodusConfigFile() as any)
            .ignorePaths;

        expect(patterns.length).toBeGreaterThan(1000);

        const rejected = patterns.filter(
            (pattern) => !checkIgnorePattern(pattern).valid,
        );

        expect(rejected).toEqual([]);
    });
});
