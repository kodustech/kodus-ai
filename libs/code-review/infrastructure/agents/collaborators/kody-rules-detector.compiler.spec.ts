import {
    compileRuleDetector,
    isDetectorRegexSafe,
    runDetector,
    RunCompiler,
    DetectorPlan,
    buildDetectorCandidates,
    normalizeDetectorExtensions,
    detectorAppliesToFile,
} from './kody-rules-detector.compiler';

const rule = (over: any = {}): any => ({
    uuid: 'r1',
    title: 't',
    rule: 'r',
    examples: [
        { isCorrect: false, snippet: 'console.log(x)' },
        { isCorrect: true, snippet: 'logger.debug(x)' },
    ],
    ...over,
});

const compiler = (out: any): RunCompiler => async () => out;

describe('compileRuleDetector — the gate (#1449 T0)', () => {
    it('declines a rule the model says is not mechanical', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({ mechanical: false, reason: 'needs judgment' }),
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('not-mechanical');
    });

    it('declines when the regex is invalid', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({ mechanical: true, pattern: '(' }),
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('invalid-regex');
    });

    it('declines when the regex misses an incorrect example (recall gate)', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({ mechanical: true, pattern: 'NEVER_MATCHES' }),
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('missed-incorrect-example');
    });

    it('declines when the regex flags a correct example (precision gate)', async () => {
        // `\blog\b` matches both console.log AND logger.debug? no — but matches
        // "logger.debug"? no. Use a loose regex that hits the correct example.
        const res = await compileRuleDetector(
            rule({
                examples: [
                    { isCorrect: false, snippet: 'const x: any = 1' },
                    { isCorrect: true, snippet: 'let anyway = 1' }, // "any" as a word
                ],
            }),
            compiler({ mechanical: true, pattern: '\\bany' }), // hits "anyway"
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('flagged-correct-example');
    });

    it('declines a loose regex that over-matches a real-code corpus', async () => {
        const corpus = [
            'const a = 1',
            '// pick any value',
            'return anyOf(x)',
            'const s = "many"',
            'log.info("ok")',
        ];
        const res = await compileRuleDetector(
            rule({
                examples: [
                    { isCorrect: false, snippet: 'const x: any = 1' },
                    { isCorrect: true, snippet: 'const y: number = 1' },
                ],
            }),
            // matches the intended site AND "any" inside comments/strings
            compiler({ mechanical: true, pattern: 'any' }),
            { corpus, maxCorpusMatchRate: 0.02 },
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('over-matches-corpus');
    });

    it('declines a ReDoS-prone regex (nested quantifier) — unsafe-regex', async () => {
        const res = await compileRuleDetector(
            rule({
                examples: [
                    { isCorrect: false, snippet: 'aaaa' },
                    { isCorrect: true, snippet: 'b' },
                ],
            }),
            compiler({ mechanical: true, pattern: '(a+)+$' }),
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('unsafe-regex');
    });

    it('declines when there are no labeled examples and no corpus', async () => {
        const res = await compileRuleDetector(
            rule({ examples: [] }),
            compiler({ mechanical: true, pattern: 'x' }),
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('no-usable-examples');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// CONTRACT tests for the LLM.run boundary of the compiler (issue #1786).
//
// The model call is injected as `runCompiler` (returns `CompilerOutput | null`);
// `compileRuleDetector` is the DETERMINISTIC layer that parses that output,
// gates it, and returns the declared `CompileResult`. We support N BYOK models;
// the non-strict ones (kimi/glm/deepseek/z-ai) fall back to `json_object` and
// can return the payload in the WRONG envelope. These tests pin the exact
// happy-path return shape and robustness to off-schema shapes.
// ───────────────────────────────────────────────────────────────────────────

describe('CONTRACT: happy path returns the exact declared shape', () => {
    it('returns exactly the DetectorPlan (deep equality, incl. compiledBy/reason/flags)', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({
                mechanical: true,
                pattern: 'console\\.(log|warn|error)\\(',
                flags: 'i',
                reason: 'no console statements',
            }),
            { modelName: 'gpt-5.4-mini' },
        );
        // no declineReason on success — the whole result object is pinned
        expect(res).toEqual({
            detector: {
                type: 'regex',
                pattern: 'console\\.(log|warn|error)\\(',
                flags: 'i',
                compiledBy: 'gpt-5.4-mini',
                reason: 'no console statements',
            },
        });
    });
});

describe('CONTRACT: off-schema / N-model envelopes (#1786) — never ships a wrong detector', () => {
    // A valid payload the strict models emit; the non-strict ones mangle the
    // envelope around it (bare array, wrapper key, stringified, wrong keys, …).
    const valid = {
        mechanical: true,
        pattern: 'console\\.(log|warn|error)\\(',
    };

    // Every one of these is a shape a json_object-fallback model actually emits.
    // The SAFE direction for this compiler is to decline → the rule stays on the
    // semantic judge (T1). What must NEVER happen is a wrong-but-valid detector
    // getting promoted from an unparsed/garbage envelope.
    it.each([
        ['null', null],
        ['empty object {}', {}],
        ['bare array instead of object', [valid]],
        ['stringified JSON', JSON.stringify(valid)],
        ['{result:{...}} wrapper', { result: valid }],
        ['right data under wrong keys', { is_mechanical: true, regex: valid.pattern }],
        ['partial object (mechanical, no pattern)', { mechanical: true }],
        ['mechanical as the string "true"', { mechanical: 'true', pattern: valid.pattern }],
        ['markdown-fenced JSON', '```json\n' + JSON.stringify(valid) + '\n```'],
    ])(
        'declines %s to the semantic judge and still returns a well-formed CompileResult',
        async (_label, out) => {
            const res = await compileRuleDetector(rule(), compiler(out as any));
            // the dangerous outcome (#1786) would be a promoted detector here
            expect(res.detector).toBeNull();
            // declared shape holds across every off-schema input
            expect(res).toHaveProperty('detector', null);
            expect(typeof res.declineReason).toBe('string');
        },
    );
});

describe('isDetectorRegexSafe — ReDoS guard', () => {
    it('rejects nested quantifiers', () => {
        expect(isDetectorRegexSafe('(a+)+$')).toBe(false);
        expect(isDetectorRegexSafe('(a*)*')).toBe(false);
        expect(isDetectorRegexSafe('([a-z]+)*')).toBe(false);
    });
    it('rejects bounded outer quantifiers on an inner-quantified group (#1480 review)', () => {
        // `{n,}`/`{n,m}` are just as catastrophic as a bare `*`/`+` when
        // applied to a group that already contains its own quantifier —
        // the pre-fix heuristic only matched a bare `*`/`+` right after
        // the group, so these slipped through.
        expect(isDetectorRegexSafe('(a+){3,}')).toBe(false);
        expect(isDetectorRegexSafe('(a*){5}')).toBe(false);
        expect(isDetectorRegexSafe('(a+){1,100}')).toBe(false);
    });
    it('accepts ordinary detector patterns', () => {
        expect(isDetectorRegexSafe('console\\.(log|warn|error)\\(')).toBe(true);
        expect(isDetectorRegexSafe('\\bDateTime\\.now\\s*\\(')).toBe(true);
    });
    it('accepts a plain quantified char class — not a nested-quantifier shape (#1480 review)', () => {
        // Regression guard: the char-class branch of the ReDoS regex
        // used to flag ANY class followed by a quantifier, regardless of
        // the class's content — so `[a-z]+`, one of the most common
        // regex shapes, was wrongly declined as unsafe. A class only
        // becomes suspect when it itself contains a quantifier-ish
        // char (e.g. `[a-z+]{2,}`), mirroring the group check.
        expect(isDetectorRegexSafe('[a-z]+')).toBe(true);
        expect(isDetectorRegexSafe('[a-zA-Z0-9_]+')).toBe(true);
        expect(isDetectorRegexSafe('[a-z]*')).toBe(true);
    });
    it('rejects an over-long pattern', () => {
        expect(isDetectorRegexSafe('a'.repeat(201))).toBe(false);
    });
});

describe('runDetector — review-time regex over added lines', () => {
    const plan: DetectorPlan = {
        type: 'regex',
        pattern: 'console\\.(log|warn|error)\\(',
    };
    it('flags only ADDED lines that match, with file+line', () => {
        const hits = runDetector(plan, [
            {
                filename: 'src/a.ts',
                patchWithLinesStr:
                    '10 +console.log(1)\n11  const ok = 1\n12 +doThing()\n13 +console.warn(2)',
            },
        ]);
        expect(hits).toEqual([
            { filename: 'src/a.ts', line: 10, code: 'console.log(1)' },
            { filename: 'src/a.ts', line: 13, code: 'console.warn(2)' },
        ]);
    });

    it('ignores context (non-+) lines even if they match', () => {
        const hits = runDetector(plan, [
            { filename: 'src/a.ts', patchWithLinesStr: '5  console.log(untouched)' },
        ]);
        expect(hits).toHaveLength(0);
    });
});

// A valid D payload the strict models emit; the json_object-fallback models
// (kimi/glm/deepseek/z-ai) mangle the envelope around it.
const validD = { mechanical: true, pattern: 'console\\.(log|warn|error)\\(' };

describe('compileRuleDetector / runDetector — edge cases', () => {
    it('A13 tolerates unknown extra keys alongside the right ones (promotes, does not crash)', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({ ...validD, flags: 'i', reason: 'no console', foo: 'bar', nested: { a: 1 } } as any),
        );
        expect(res.detector).not.toBeNull();
        expect(res.detector!.pattern).toBe(validD.pattern);
    });

    it('D36 a single incorrect example is enough to gate + promote', async () => {
        const res = await compileRuleDetector(
            rule({ examples: [{ isCorrect: false, snippet: 'console.log(x)' }] }),
            compiler(validD),
        );
        expect(res.detector).not.toBeNull();
    });

    it('D39 null example entries and null snippets are filtered, not thrown on', async () => {
        const res = await compileRuleDetector(
            rule({
                examples: [
                    null,
                    { isCorrect: false, snippet: null },
                    { isCorrect: false, snippet: 'console.log(x)' },
                    { isCorrect: true, snippet: 'logger.debug(x)' },
                ],
            }),
            compiler(validD),
        );
        expect(res.detector).not.toBeNull();
    });

    it('D39 undefined examples array is treated as no labeled signal, not a crash', async () => {
        const res = await compileRuleDetector(
            rule({ examples: undefined }),
            compiler(validD),
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('no-usable-examples');
    });

    it('D40 an absurdly long added line is skipped by the ReDoS input bound', () => {
        const huge = 'console.log(' + 'x'.repeat(2100) + ')';
        const hits = runDetector(
            { type: 'regex', pattern: 'console\\.log\\(' },
            [{ filename: 'a.ts', patchWithLinesStr: '1 +' + huge }],
        );
        expect(hits).toHaveLength(0);
    });
});

// ── issue #1831 acceptance criteria ─────────────────────────────────────────
// Every case below is a shape the incident actually produced, measured against
// 40 real merged PRs from polyglot Ruby repos (the 2026 detector repro; today
// evals/kody-rules/polyglot-cases.json runs it through production's review).
// The rule is the real one: a Ruby-scoped "avoid
// unnecessary semicolons" whose compiled detector was `;\s*(?:#.*)?$` with an
// empty `path`. It published 614 comments over that corpus; not one was a true
// violation.
describe('#1831 — a detector cannot publish, and cannot leave its language', () => {
    const semicolonRule = {
        uuid: 'ruby-no-semicolons',
        title: 'Avoid unnecessary semicolons',
        rule: 'Avoid unnecessary semicolons at the end of statements. Ruby does not require semicolons to terminate statements.',
        path: '',
    };
    const file = (filename: string, lines: string[]) => ({
        filename,
        patchWithLinesStr: lines
            .map((l, i) => `${i + 1} +${l}`)
            .join('\n'),
    });

    it('AC: a cosmetic rule never compiles into a detector at all', async () => {
        // Layer 1. Formatting a linter owns is not worth a review comment even
        // when a regex matches it perfectly, so the gate declines it BEFORE the
        // compile call — no model opinion required.
        const runCompiler = jest.fn();
        const res = await compileRuleDetector(
            semicolonRule as any,
            runCompiler as any,
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('cosmetic');
        expect(runCompiler).not.toHaveBeenCalled();
    });

    it.each([
        ['quote style', 'Always use double-quoted strings for attribute values'],
        ['blank lines', 'Do not leave two consecutive blank lines'],
        ['indentation', 'Use two spaces for indentation, never tabs'],
        ['line length', 'Keep line length under 120 characters'],
        ['statements per line', 'Write one statement per line'],
    ])('AC: the compiler declines the %s rule as cosmetic', async (_label, text) => {
        const res = await compileRuleDetector(
            { uuid: 'x', title: text, rule: text } as any,
            jest.fn() as any,
        );
        expect(res.declineReason).toBe('cosmetic');
    });

    it('AC: a rule whose text names a language produces no candidate on another language', () => {
        // Layer 2. The exact regression the issue asks for: the Ruby semicolon
        // rule against a diff of .js / .md / .scss / .yml lines ending in ';'.
        const scoped = {
            ...semicolonRule,
            detector: {
                type: 'regex' as const,
                pattern: ';\\s*(?:#.*)?$',
                extensions: ['.rb', '.rake', '.erb'],
            },
        };
        const files = [
            file('app/assets/app.js', ['const x = 1;']),
            file('README.md', ['Run the migration;']),
            file('app/assets/app.scss', ['color: red;']),
            file('config/deploy.yml', ['cmd: "run;"']),
            file('app/models/user.rb', ['x = 1;']),
        ];
        const index = buildDetectorCandidates([scoped] as any, files as any);
        const hitFiles = [...(index.get('ruby-no-semicolons') ?? new Map()).keys()];
        expect(hitFiles).toEqual(['app/models/user.rb']);
    });

    it('AC: an unscoped detector still leaks across languages — which is why the judge is the safety net', () => {
        // The 424 detectors already in the fleet carry no `extensions` until
        // they are recompiled, so this documents what layer 2 does NOT cover:
        // the leak is still there, and only confirmation stops it shipping.
        const unscoped = {
            ...semicolonRule,
            detector: { type: 'regex' as const, pattern: ';\\s*(?:#.*)?$' },
        };
        const index = buildDetectorCandidates(
            [unscoped] as any,
            [file('app/assets/app.scss', ['color: red;'])] as any,
        );
        expect([...(index.get('ruby-no-semicolons') ?? new Map()).keys()]).toEqual([
            'app/assets/app.scss',
        ]);
    });

    it('AC: hits inside a SQL heredoc and an embedded-JS template are candidates, never findings', () => {
        // Layer 3's job. Both shapes are real: `WHERE (published = true);` inside
        // a `<<~SQL` heredoc in a Rails migration, and a `const url = new
        // URL(...);` inside an .erb view. Extension scope cannot see either —
        // the .rb and .erb files ARE Ruby. buildDetectorCandidates returns
        // candidates, and the ONLY thing it can return is candidates: there is
        // no code path from a regex hit to a published suggestion.
        const scoped = {
            ...semicolonRule,
            detector: {
                type: 'regex' as const,
                pattern: ';\\s*(?:#.*)?$',
                extensions: ['.rb', '.erb'],
            },
        };
        const files = [
            file('db/migrate/20260101_add_index.rb', [
                'conn.exec(<<~SQL.squish)',
                '  CREATE INDEX CONCURRENTLY index_articles_on_score',
                '  ON articles (score)',
                '  WHERE (published = true);',
                'SQL',
            ]),
            file('app/views/events/show.html.erb', [
                '<script>',
                '  const url = new URL(chatFrame.src);',
                '</script>',
            ]),
        ];
        const index = buildDetectorCandidates([scoped] as any, files as any);
        const perFile = index.get('ruby-no-semicolons')!;
        expect(perFile.get('db/migrate/20260101_add_index.rb')).toEqual([4]);
        expect(perFile.get('app/views/events/show.html.erb')).toEqual([2]);
        // A DetectorHitIndex carries line numbers and nothing else — no
        // suggestion text, no severity, nothing shaped like a finding. Keeping
        // it that way is what makes "cannot publish" structural rather than a
        // convention someone has to remember.
        for (const lines of perFile.values()) {
            expect(lines.every((l) => typeof l === 'number')).toBe(true);
        }
    });

    it('AC: extensions are normalized, and a garbage scope never silences the rule', () => {
        expect(normalizeDetectorExtensions(['RB', '.Erb', 'rake'])).toEqual([
            '.rb',
            '.erb',
            '.rake',
        ]);
        // Globs / paths / prose are not extensions. If NOTHING survives, the
        // result is undefined (no scope) rather than an empty list — an empty
        // list would match no file and silently disable the rule.
        expect(normalizeDetectorExtensions(['*.rb', 'app/models/', 'ruby files'])).toBeUndefined();
        expect(normalizeDetectorExtensions([])).toBeUndefined();
        expect(normalizeDetectorExtensions(undefined)).toBeUndefined();
    });

    // Measured against production, 08/09/2026: over a sample of 60 real rules
    // that name a language in their own text, the compiler returned a usable
    // scope for 38 of 47 that answered. One of the misses was this shape:
    //
    //   "Avoid N+1 SQL Queries Inside Loops"
    //     -> ["<.sql>","<.rb>","<.py>","<.js>","<.java>"]
    //
    // The model knew the languages and copied the ANGLE BRACKETS from the
    // prompt's own JSON template (`"extensions": ["<.ext>", …]`). Every entry
    // then failed the extension pattern and a correct answer was discarded, so
    // the rule shipped unscoped. This is recovered data, not a guess: the
    // brackets are the template's punctuation, never part of an extension.
    it('recovers extensions the model wrapped in the prompt template brackets', () => {
        expect(
            normalizeDetectorExtensions([
                '<.sql>',
                '<.rb>',
                '<.py>',
                '<.js>',
                '<.java>',
            ]),
        ).toEqual(['.sql', '.rb', '.py', '.js', '.java']);

        // Bracket-stripping must not resurrect the shapes that are genuinely
        // not extensions — a glob is still a glob once unwrapped.
        expect(
            normalizeDetectorExtensions(['<*.rb>', '<app/models/>', '<>']),
        ).toBeUndefined();
    });

    // Compound suffixes. Whole ecosystems name files with two segments, and the
    // single-segment pattern silently dropped the second half: one real rule
    // answered [".php", ".blade.php"] and kept only the first. Nothing below
    // enumerates a language — the SHAPE is all that is checked, so a technology
    // nobody anticipated works the day a rule names it.
    describe('compound extensions', () => {
        it('keeps a two-segment suffix instead of discarding it', () => {
            expect(
                normalizeDetectorExtensions(['.php', '.blade.php']),
            ).toEqual(['.php', '.blade.php']);
            expect(normalizeDetectorExtensions(['.spec.ts', '.d.ts'])).toEqual([
                '.spec.ts',
                '.d.ts',
            ]);
            expect(normalizeDetectorExtensions(['.tar.gz'])).toEqual(['.tar.gz']);
        });

        it('still refuses globs, paths and prose', () => {
            expect(
                normalizeDetectorExtensions([
                    '*.rb',
                    'app/models/',
                    'ruby files',
                    '.a.b.c.d.e',
                ]),
            ).toBeUndefined();
        });

        it('matches by SUFFIX, so a broad scope still covers a compound name', () => {
            const d = (extensions: string[]) =>
                ({ type: 'regex', pattern: 'x', extensions }) as any;

            // `.ts` covers every TypeScript file, spec files included.
            expect(detectorAppliesToFile('src/a.spec.ts', d(['.ts']))).toBe(true);
            expect(detectorAppliesToFile('src/a.ts', d(['.ts']))).toBe(true);
        });

        it('lets a rule scope itself to ONLY the compound kind', () => {
            // This is the distinction a last-segment comparison could never
            // express, and it is the one the "do not apply this to tests" axis
            // needs: 24% of rule thumbs-down in production land on spec/test
            // files.
            const specOnly = {
                type: 'regex',
                pattern: 'x',
                extensions: ['.spec.ts'],
            } as any;

            expect(detectorAppliesToFile('src/a.spec.ts', specOnly)).toBe(true);
            expect(detectorAppliesToFile('src/a.ts', specOnly)).toBe(false);
        });

        it('does not confuse a shorter extension with the tail of a longer one', () => {
            const js = { type: 'regex', pattern: 'x', extensions: ['.js'] } as any;
            // "app.mjs" ends in "mjs", not in ".js" — the dot is part of the
            // compared string, so this is not a match.
            expect(detectorAppliesToFile('app.mjs', js)).toBe(false);
            expect(detectorAppliesToFile('app.min.js', js)).toBe(true);
        });
    });

    it('a scoped detector still covers extensionless files (Rakefile, Gemfile, Dockerfile)', () => {
        // Review feedback on #1864. The extension check is a COST filter, so
        // when it cannot determine a language it must abstain, not exclude:
        // excluding would be a silent enforcement loss, because the judge only
        // shards files where a detector fired, so nothing downstream would ever
        // look at a Rakefile a Ruby rule genuinely applies to.
        const scoped = {
            uuid: 'ruby-rule',
            title: 't',
            rule: 'ruby only',
            detector: {
                type: 'regex' as const,
                pattern: 'puts ',
                extensions: ['.rb'],
            },
        };
        const files = [
            file('Rakefile', ['puts "hi"']),
            file('Gemfile', ['puts "hi"']),
            file('Dockerfile', ['puts "hi"']),
            file('app/assets/app.scss', ['puts "hi"']),
        ];
        const hit = [...buildDetectorCandidates([scoped] as any, files as any)
            .get('ruby-rule')!
            .keys()].sort();
        // .scss is excluded (known extension, not in scope); the extensionless
        // files are kept and left for the judge to rule on.
        expect(hit).toEqual(['Dockerfile', 'Gemfile', 'Rakefile']);
    });

    it('AC: a language-agnostic rule keeps running everywhere', () => {
        // The scope must not become a silent narrowing. A rule that names no
        // language compiles with no extensions and behaves exactly as before.
        const anyLang = {
            uuid: 'no-todo',
            title: 'No TODO comments',
            rule: 'Do not leave TODO comments in committed code.',
            detector: { type: 'regex' as const, pattern: 'TODO' },
        };
        const index = buildDetectorCandidates(
            [anyLang] as any,
            [
                file('a.rb', ['# TODO fix']),
                file('b.tsx', ['// TODO fix']),
                file('c.md', ['TODO fix']),
            ] as any,
        );
        expect([...index.get('no-todo')!.keys()].sort()).toEqual([
            'a.rb',
            'b.tsx',
            'c.md',
        ]);
    });
});
