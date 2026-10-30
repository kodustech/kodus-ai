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
    // one character and stays bounded. `[!(x)]` and `**/[!()]*.ts` are the
    // awkward ones: "!(" appears inside the class by coincidence and must not
    // read as an extglob.
    it.each([
        '[!abc]*.js',
        '[!]]',
        '**/[!._]*.ts',
        'a!b.txt',
        '[!(x)]',
        '**/[!()]*.ts',
        '[!(]*.ts',
        'src/[!(a|b)]/*.ts',
        '**/[!](]*.ts',
        'a\\!(b).txt',
    ])('leaves the character class or escaped "!" %j alone', (pattern) => {
        expect(checkIgnorePattern(pattern)).toEqual({ valid: true });
    });

    // Generated rather than hand-listed: three rounds of review each found a
    // shape the hand-listed cases missed. The safety property is what matters
    // — nothing the checker accepts may behave like a path negation — so
    // assert that directly over a matrix of shapes.
    it('never accepts a pattern that swallows the tree', () => {
        const corpus = [
            'README.md',
            'package.json',
            'app.js',
            'foo.js',
            'src/app.ts',
            'src/deep/a.ts',
            'src/_private.ts',
            'lib/x.js',
            'a/foo.ts',
            'b/bar.ts',
            'docs/y.md',
            'a/deep/n/x.ts',
            'node_modules/p/i.js',
            '.env',
            'vendor/dep.php',
        ];
        const share = (pattern: string) => {
            const match = picomatch(pattern, { dot: true, nocase: false });
            // One argument on purpose — picomatch's second parameter switches
            // the return from a boolean to an object, so handing the matcher
            // straight to filter() makes every index >= 1 come back truthy.
            return corpus.filter((file) => match(file)).length / corpus.length;
        };

        const bodies = ['x', 'a|b', 'node_modules', '*.js', '*', 'a|(b|c)'];
        const prefixes = ['', '**/', 'src/', 'a/b/'];
        const tails = ['', '.js', '/**', '/*.ts'];

        const negations = new Set<string>();
        const harmless = new Set<string>();

        for (const body of bodies) {
            for (const prefix of prefixes) {
                for (const tail of tails) {
                    negations.add(`${prefix}!(${body})${tail}`);
                    negations.add(`${prefix}*.!(${body})${tail}`);

                    // Same shape, quantifier head instead of "!": these group
                    // and repeat, they do not invert, so they must be allowed
                    // however broad they happen to be.
                    for (const head of ['@', '+', '*', '?']) {
                        harmless.add(`${prefix}${head}(${body})${tail}`);
                        harmless.add(`${prefix}*.${head}(${body})${tail}`);
                    }
                }
            }
        }
        for (const cls of ['[!abc]', '[!(x)]', '[!()]', '[abc]', '[a-z]']) {
            for (const prefix of prefixes) {
                for (const tail of tails) {
                    harmless.add(`${prefix}${cls}${tail}`);
                    harmless.add(`${prefix}${cls}*${tail}`);
                }
            }
        }

        // Syntax failures are a different verdict; keep them out so this only
        // measures the negation rule.
        const parses = (pattern: string) =>
            checkGlobPatternSyntax(pattern).valid;
        const negationList = [...negations].filter(parses);
        const harmlessList = [...harmless].filter(parses);

        expect(negationList.length).toBeGreaterThan(100);
        expect(harmlessList.length).toBeGreaterThan(200);

        // Every negation is rejected, wherever the "!(" sits in the pattern.
        expect(
            negationList.filter((p) => checkIgnorePattern(p).valid),
        ).toEqual([]);

        // Nothing else is, including the bracket classes that merely contain
        // the characters "!" and "(" side by side.
        expect(
            harmlessList.filter((p) => !checkIgnorePattern(p).valid),
        ).toEqual([]);

        // The rule has to be earning its keep: enough of what it rejects must
        // really swallow the tree, or it is guarding nothing.
        expect(
            negationList.filter((p) => share(p) >= 0.6).length,
        ).toBeGreaterThan(10);

        // And breadth alone is not the crime — some allowed patterns are wide
        // on purpose (`**/*`), which is why the rule keys on negation, not on
        // how much a pattern happens to match.
        expect(
            harmlessList.filter((p) => share(p) >= 0.6).length,
        ).toBeGreaterThan(0);
    });

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
