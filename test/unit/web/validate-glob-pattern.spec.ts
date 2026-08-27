import picomatch from 'picomatch';

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
    // re-inclusion, so "!" inverts instead of un-ignoring: it matches every
    // file the rest of the pattern does NOT, dropping most of the repo from
    // review. Two earlier attempts at a "safe subset" each left a hole — a
    // bare-"!" check missed `!(a|b)/**`, and a leading-only check missed
    // `**/!(node_modules)/**` and `**/*.!(js)` — so nothing negating passes.
    const NEGATIONS = [
        '!src/**',
        '!**/*.json',
        '!dist',
        '!!weird',
        '!(foo).js',
        '**/!(foo).js',
        '!(a|b)/**',
        '!(node_modules)/**',
        '**/!(node_modules)/**',
        'src/!(vendor)/**',
        '**/*.!(js)',
        '**/!(*.js)',
        '!(a|(b|c))/**',
        '!(*.js)',
        '!(*/**)',
    ];

    it.each(NEGATIONS)('rejects the negation %j', (pattern) => {
        const result = checkIgnorePattern(pattern);

        expect(result.valid).toBe(false);
        expect((result as { message: string }).message).toMatch(
            /Negation is not supported/,
        );
    });

    // A negated character class is not a negation of the path — it excludes
    // one character and stays bounded.
    it.each(['[!abc]*.js', '[!]]', '**/[!._]*.ts', 'a!b.txt'])(
        'leaves the negated character class %j alone',
        (pattern) => {
            expect(checkIgnorePattern(pattern)).toEqual({ valid: true });
        },
    );

    // Ties the rule to measured behaviour instead of to a belief about glob
    // semantics: every shape above really does swallow a large share of a
    // mixed tree, and every shape below really is bounded. If picomatch ever
    // changes its mind about one of these, this fails rather than the rule
    // silently protecting nothing.
    it('rejects the shapes that actually swallow a tree, keeps the bounded ones', () => {
        const corpus = [
            'README.md',
            'package.json',
            'app.js',
            'src/app.ts',
            'src/deep/a.ts',
            'lib/x.js',
            'a/foo.ts',
            'b/bar.ts',
            'docs/y.md',
            'a/deep/n/x.ts',
            'node_modules/p/i.js',
        ];
        const share = (pattern: string) => {
            const match = picomatch(pattern, { dot: true, nocase: false });
            // Call with one argument on purpose: picomatch's second parameter
            // makes it return an object instead of a boolean, so passing the
            // matcher straight to filter() feeds it the index and everything
            // from index 1 on comes back truthy.
            return corpus.filter((file) => match(file)).length / corpus.length;
        };

        const wideOpen = NEGATIONS.filter((p) => share(p) >= 0.6);

        // Not every negation is wide, but the dangerous ones must be in here
        // and must all be rejected.
        expect(wideOpen).toEqual(
            expect.arrayContaining([
                '!src/**',
                '!(a|b)/**',
                '!(node_modules)/**',
                '**/!(node_modules)/**',
                '**/*.!(js)',
            ]),
        );
        for (const pattern of wideOpen) {
            expect([pattern, checkIgnorePattern(pattern).valid]).toEqual([
                pattern,
                false,
            ]);
        }

        for (const pattern of ['[!abc]*.js', '[!]]', '**/*.ts']) {
            expect(share(pattern)).toBeLessThan(0.6);
        }
    });

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
