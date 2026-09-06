import {
    compileRuleDetector,
    isDetectorRegexSafe,
    runDetector,
    RunCompiler,
    DetectorPlan,
    makeLLMRunCompiler,
    buildCompilerUserPrompt,
    COMPILER_SYSTEM_PROMPT,
    buildDetectorCandidates,
    normalizeDetectorExtensions,
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
    it('promotes a mechanical rule whose regex reproduces its examples', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({ mechanical: true, pattern: 'console\\.(log|warn|error)\\(' }),
        );
        expect(res.detector).not.toBeNull();
        expect(res.detector!.pattern).toContain('console');
    });

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
// can return the payload in the WRONG envelope. These tests pin the request
// assembly, the exact happy-path return shape, robustness to off-schema shapes,
// and the fail-safe when the model call rejects.
// ───────────────────────────────────────────────────────────────────────────

describe('CONTRACT: request assembly (makeLLMRunCompiler)', () => {
    it('calls the underlying model with the compiler system prompt and the assembled user prompt', async () => {
        const call = jest.fn().mockResolvedValue({ mechanical: false });
        const run = makeLLMRunCompiler(call);
        const r = rule();

        const out = await run(r);

        expect(call).toHaveBeenCalledTimes(1);
        const arg = call.mock.calls[0][0];
        expect(arg.system).toBe(COMPILER_SYSTEM_PROMPT);
        expect(arg.user).toBe(buildCompilerUserPrompt(r));
        // the rule's labeled examples must reach the model verbatim
        expect(arg.user).toContain('console.log(x)');
        expect(arg.user).toContain('incorrect');
        // makeLLMRunCompiler is a pure adapter: it returns the call's result untouched
        expect(out).toEqual({ mechanical: false });
    });
});

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
        ['undefined', undefined],
        ['empty object {}', {}],
        ['bare array instead of object', [valid]],
        ['bare empty array', []],
        ['stringified JSON', JSON.stringify(valid)],
        ['{result:{...}} wrapper', { result: valid }],
        ['{data:{...}} wrapper', { data: valid }],
        ['right data under wrong keys', { is_mechanical: true, regex: valid.pattern }],
        ['partial object (mechanical, no pattern)', { mechanical: true }],
        ['mechanical as the string "true"', { mechanical: 'true', pattern: valid.pattern }],
        ['mechanical as the number 1', { mechanical: 1, pattern: valid.pattern }],
        ['pattern present but mechanical missing', { pattern: valid.pattern }],
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

    // ── Known #1786 degradations: the current code silently drops repairable
    // valid payloads (and disguises parse failures as a semantic decision).
    // These assert the CORRECT non-degrading behavior, so they stay green now
    // (jest it.failing) and flip to real failures the day #1786 is fixed.

    it.failing(
        'repairs a stringified-JSON envelope and promotes the valid detector (kimi/glm double-encode)',
        async () => {
            const res = await compileRuleDetector(
                rule(),
                compiler(JSON.stringify(valid)),
            );
            expect(res.detector).not.toBeNull();
            expect(res.detector!.pattern).toContain('console');
        },
    );

    it.failing(
        'unwraps a {result:{...}} envelope and promotes the valid detector',
        async () => {
            const res = await compileRuleDetector(
                rule(),
                compiler({ result: valid }),
            );
            expect(res.detector).not.toBeNull();
        },
    );

    it.failing(
        'signals an unparseable envelope distinctly, not as a genuine not-mechanical decision',
        async () => {
            // A garbage object must not masquerade as "the model judged this rule
            // non-mechanical" — otherwise #1786 output failures are invisible in
            // observability (the decline reason is the only signal downstream).
            const res = await compileRuleDetector(
                rule(),
                compiler({ foo: 'bar' }),
            );
            expect(res.detector).toBeNull();
            expect(res.declineReason).not.toBe('not-mechanical');
        },
    );
});

describe('CONTRACT: fail-safe when the model call rejects', () => {
    const rejecting: RunCompiler = async () => {
        throw new Error('provider 500 / suspended BYOK key');
    };

    it.failing(
        'degrades to a declined result instead of throwing past its boundary',
        async () => {
            // Documented fallback: a failed compile means the rule stays semantic,
            // never an exception bubbling into the review pipeline.
            await expect(
                compileRuleDetector(rule(), rejecting),
            ).resolves.toMatchObject({ detector: null });
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

// ═══════════════════════════════════════════════════════════════════════════
// BACKFILL (#1786): close the FULL LLM.run I/O contract matrix for the compiler
// output-parse boundary. `compileRuleDetector` is the deterministic layer that
// consumes `runCompiler`'s output (declared schema D = CompilerOutput
// {mechanical, pattern?, flags?, reason?}) and returns CompileResult. The
// boundary is model-agnostic — the strict-json_schema vs json_object gate lives
// upstream in structured-output-gate — so the full A/B/C off-schema zoo is in
// scope here and must NEVER promote a wrong detector nor throw past the stage.
// ═══════════════════════════════════════════════════════════════════════════

// A valid D payload the strict models emit; the json_object-fallback models
// (kimi/glm/deepseek/z-ai) mangle the envelope around it.
const validD = { mechanical: true, pattern: 'console\\.(log|warn|error)\\(' };

describe('CONTRACT A: output-shape zoo — remaining envelopes decline safely (observable)', () => {
    // For every off-schema shape that carries NO directly-usable D, the
    // documented safe-default is: decline to the semantic judge (detector:null)
    // with an observable string declineReason — never a silently-promoted
    // wrong detector.
    it.each([
        ['A4 {output:D} wrapper', { output: validD }],
        ['A4 {response:D} wrapper', { response: validD }],
        ['A4 {json:D} wrapper', { json: validD }],
        ['A5 double {result:{result:D}} wrapper', { result: { result: validD } }],
        ['A6 numeric single-key {"0":D} wrap', { 0: validD }],
        ['A6 {content:D} opaque wrap', { content: validD }],
        ['A8 markdown-fenced JSON', '```json\n' + JSON.stringify(validD) + '\n```'],
        ['A9 prose-wrapped JSON', 'Here is the result: ' + JSON.stringify(validD) + '\nLet me know!'],
        ['A11 case/convention mismatch (Mechanical/Pattern)', { Mechanical: true, Pattern: validD.pattern }],
        ['A16 empty string', ''],
        ['A16 whitespace-only string', '   \n\t '],
        ['A18 primitive true', true],
        ['A18 primitive 0', 0],
        ['A18 primitive "ok"', 'ok'],
        ['A19 provider envelope leak {choices:[{message:{content}}]}', { choices: [{ message: { content: JSON.stringify(validD) } }] }],
        ['A20 thinking/reasoning leak block', { content: [{ type: 'thinking', thinking: 'let me think' }, { type: 'text', text: JSON.stringify(validD) }] }],
    ])('declines %s with a well-formed CompileResult', async (_label, out) => {
        const res = await compileRuleDetector(rule(), compiler(out as any));
        expect(res.detector).toBeNull();
        expect(res).toHaveProperty('detector', null);
        expect(typeof res.declineReason).toBe('string');
    });

    it('A13 tolerates unknown extra keys alongside the right ones (promotes, does not crash)', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({ ...validD, flags: 'i', reason: 'no console', foo: 'bar', nested: { a: 1 } } as any),
        );
        expect(res.detector).not.toBeNull();
        expect(res.detector!.pattern).toBe(validD.pattern);
    });
});

describe('CONTRACT A: recoverable payloads that prod silently drops (#1786 known degradations)', () => {
    // Each shape here contains the real, valid D. The NON-DEGRADING behavior is
    // to recover it and promote the detector. Today compileRuleDetector's guard
    // (`out.mechanical !== true`) drops these to 'not-mechanical', so these are
    // it.failing: green now, they flip red the day the repair path lands.
    it.failing('A4 recovers {output:D} and promotes', async () => {
        const res = await compileRuleDetector(rule(), compiler({ output: validD }));
        expect(res.detector).not.toBeNull();
    });
    it.failing('A4 recovers {response:D} and promotes', async () => {
        const res = await compileRuleDetector(rule(), compiler({ response: validD }));
        expect(res.detector).not.toBeNull();
    });
    it.failing('A4 recovers {json:D} and promotes', async () => {
        const res = await compileRuleDetector(rule(), compiler({ json: validD }));
        expect(res.detector).not.toBeNull();
    });
    it.failing('A5 recovers double {result:{result:D}} and promotes', async () => {
        const res = await compileRuleDetector(rule(), compiler({ result: { result: validD } }));
        expect(res.detector).not.toBeNull();
    });
    it.failing('A6 recovers {content:D} and promotes', async () => {
        const res = await compileRuleDetector(rule(), compiler({ content: validD }));
        expect(res.detector).not.toBeNull();
    });
    it.failing('A8 repairs markdown-fenced JSON and promotes', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler('```json\n' + JSON.stringify(validD) + '\n```'),
        );
        expect(res.detector).not.toBeNull();
    });
    it.failing('A9 extracts prose-wrapped JSON and promotes', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler('Here is the result: ' + JSON.stringify(validD) + '\nLet me know!'),
        );
        expect(res.detector).not.toBeNull();
    });
    it.failing('A11 aliases case/convention-mismatched keys and promotes', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({ Mechanical: true, Pattern: validD.pattern }),
        );
        expect(res.detector).not.toBeNull();
    });
});

describe('CONTRACT B: semantic-but-wrong value encodings', () => {
    it('B22 declines a yes/no-boolean (current safe outcome is observable)', async () => {
        // "yes" is a truthy affirmation but !== true → declines today.
        const res = await compileRuleDetector(
            rule(),
            compiler({ mechanical: 'yes', pattern: validD.pattern } as any),
        );
        expect(res.detector).toBeNull();
        expect(typeof res.declineReason).toBe('string');
    });
    it.failing('B22 coerces mechanical:"yes" to true and promotes (#1786)', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({ mechanical: 'yes', pattern: validD.pattern } as any),
        );
        expect(res.detector).not.toBeNull();
    });
    it('B22 mechanical:"no" correctly stays declined (recovery would also decline)', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({ mechanical: 'no', reason: 'needs judgment' } as any),
        );
        expect(res.detector).toBeNull();
    });
    it('B26 a stringified JSON body with duplicate keys is not trusted as an object (fail-safe)', async () => {
        // The parse layer receives a raw string, not a parsed object; last-wins
        // JSON.parse semantics never get a chance to promote a wrong detector.
        const res = await compileRuleDetector(
            rule(),
            compiler('{"mechanical":false,"mechanical":true,"pattern":"' + validD.pattern.replace(/\\/g, '\\\\') + '"}'),
        );
        expect(res.detector).toBeNull();
        expect(typeof res.declineReason).toBe('string');
    });
    it('B27 preserves unicode/emoji/escaped content in string fields when promoting', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({
                mechanical: true,
                pattern: validD.pattern,
                reason: 'no console 🚫 — véfïçá \\n newline',
            }),
        );
        expect(res.detector).not.toBeNull();
        expect(res.detector!.reason).toBe('no console 🚫 — véfïçá \\n newline');
    });
});

describe('CONTRACT C: unparseable / transport — fail-safe layer', () => {
    it('C28 declines a truncated JSON body (documented fallback, no crash)', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler('{"mechanical":true,"pattern":"con'),
        );
        expect(res.detector).toBeNull();
        expect(typeof res.declineReason).toBe('string');
    });
    it('C29 declines a malformed JSON body (trailing comma / unquoted keys)', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler('{mechanical: true, pattern: "x",}'),
        );
        expect(res.detector).toBeNull();
        expect(typeof res.declineReason).toBe('string');
    });
    it('C31 declines an error-object return {error:...} instead of trusting it', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({ error: 'rate limited', code: 429 } as any),
        );
        expect(res.detector).toBeNull();
        expect(typeof res.declineReason).toBe('string');
    });
    it('C32 declines an empty-success return', async () => {
        const res = await compileRuleDetector(rule(), compiler(''));
        expect(res.detector).toBeNull();
        expect(typeof res.declineReason).toBe('string');
    });
    it('C33 declines a refusal prose return ("I cannot help…")', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler("I'm sorry, but I can't help with that request."),
        );
        expect(res.detector).toBeNull();
        expect(typeof res.declineReason).toBe('string');
    });
    it.failing('C34 an aborted call fails safe (declines) rather than throwing past the boundary', async () => {
        const aborting: RunCompiler = async () => {
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            throw e;
        };
        await expect(
            compileRuleDetector(rule(), aborting),
        ).resolves.toMatchObject({ detector: null });
    });
});

describe('CONTRACT D: input variants into the boundary', () => {
    // D35 — empty inputs across the three surfaces.
    it('D35 empty examples + no corpus declines (no-usable-examples), not a crash', async () => {
        const res = await compileRuleDetector(rule({ examples: [] }), compiler(validD));
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('no-usable-examples');
    });
    it('D35 runDetector over zero changed files returns []', () => {
        expect(runDetector({ type: 'regex', pattern: 'x' }, [])).toEqual([]);
    });
    it('D35 buildDetectorCandidates over zero rules / zero files returns an empty index', () => {
        expect(buildDetectorCandidates([], []).size).toBe(0);
    });

    // D36 — single item.
    it('D36 a single incorrect example is enough to gate + promote', async () => {
        const res = await compileRuleDetector(
            rule({ examples: [{ isCorrect: false, snippet: 'console.log(x)' }] }),
            compiler(validD),
        );
        expect(res.detector).not.toBeNull();
    });

    // D38 — duplicate items.
    it('D38 duplicate examples do not change the compile decision (idempotent)', async () => {
        const dup = {
            examples: [
                { isCorrect: false, snippet: 'console.log(x)' },
                { isCorrect: false, snippet: 'console.log(x)' },
                { isCorrect: true, snippet: 'logger.debug(x)' },
                { isCorrect: true, snippet: 'logger.debug(x)' },
            ],
        };
        const res = await compileRuleDetector(rule(dup), compiler(validD));
        expect(res.detector).not.toBeNull();
    });
    it('D38 duplicate matching added lines produce one hit each (no silent dedup)', () => {
        const hits = runDetector(
            { type: 'regex', pattern: 'console\\.log\\(' },
            [{ filename: 'a.ts', patchWithLinesStr: '1 +console.log(1)\n2 +console.log(1)' }],
        );
        expect(hits).toHaveLength(2);
    });

    // D39 — null / undefined required fields.
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

    // D40 — special chars / whitespace / huge lines.
    it('D40 whitespace-only diff yields no hits (no added-line content)', () => {
        const hits = runDetector(
            { type: 'regex', pattern: 'console\\.log\\(' },
            [{ filename: 'a.ts', patchWithLinesStr: '   \n\t\n' }],
        );
        expect(hits).toHaveLength(0);
    });
    it('D40 an absurdly long added line is skipped by the ReDoS input bound', () => {
        const huge = 'console.log(' + 'x'.repeat(2100) + ')';
        const hits = runDetector(
            { type: 'regex', pattern: 'console\\.log\\(' },
            [{ filename: 'a.ts', patchWithLinesStr: '1 +' + huge }],
        );
        expect(hits).toHaveLength(0);
    });
    it('D40 a pattern with special/unicode chars still promotes and round-trips', async () => {
        const res = await compileRuleDetector(
            rule({
                examples: [
                    { isCorrect: false, snippet: 'const café = "😀"' },
                    { isCorrect: true, snippet: 'const tea = 1' },
                ],
            }),
            compiler({ mechanical: true, pattern: 'café' }),
        );
        expect(res.detector).not.toBeNull();
        expect(res.detector!.pattern).toBe('café');
    });

    // D42 — order permutation is metamorphic: same decision regardless of order.
    it('D42 example order does not change the compile decision', async () => {
        const forward = await compileRuleDetector(
            rule({
                examples: [
                    { isCorrect: false, snippet: 'console.log(x)' },
                    { isCorrect: true, snippet: 'logger.debug(x)' },
                ],
            }),
            compiler(validD),
        );
        const reversed = await compileRuleDetector(
            rule({
                examples: [
                    { isCorrect: true, snippet: 'logger.debug(x)' },
                    { isCorrect: false, snippet: 'console.log(x)' },
                ],
            }),
            compiler(validD),
        );
        expect(forward).toEqual(reversed);
    });
    it('D42 changed-file order does not change the set of detector candidates', () => {
        const plan: DetectorPlan = { type: 'regex', pattern: 'console\\.log\\(' };
        const rules = [{ uuid: 'r1', title: 't', rule: 'no console', detector: plan }];
        const fA = { filename: 'a.ts', patchWithLinesStr: '1 +console.log(1)' } as any;
        const fB = { filename: 'b.ts', patchWithLinesStr: '2 +console.log(2)' } as any;
        const key = (idx: any) =>
            new Set(
                [...idx.get('r1')!].flatMap(([f, lines]: any) =>
                    lines.map((l: number) => `${f}:${l}`),
                ),
            );
        expect(key(buildDetectorCandidates(rules as any, [fA, fB]))).toEqual(
            key(buildDetectorCandidates(rules as any, [fB, fA])),
        );
    });
});

describe('CONTRACT E: N-model policy — boundary is model-agnostic (gate lives upstream)', () => {
    // structured-output-gate decides strict-json_schema (openai/anthropic/google/
    // moonshotai → trusts clean D) vs json_object fallback (kimi/glm/deepseek/
    // z-ai → full zoo). compileRuleDetector receives an already-parsed output and
    // never branches on model, so its defense against off-schema shapes MUST be
    // identical whichever model produced it — the `modelName` opt only labels
    // `compiledBy`, it must not relax the gate.
    it.each([
        ['strict-json_schema model', 'openai/gpt-5.4-mini'],
        ['json_object-fallback model', 'kimi/k2'],
    ])('an off-schema {result:D} envelope declines identically under a %s', async (_label, modelName) => {
        const res = await compileRuleDetector(
            rule(),
            compiler({ result: validD }),
            { modelName },
        );
        expect(res.detector).toBeNull();
        expect(typeof res.declineReason).toBe('string');
    });
    it.each([
        ['strict-json_schema model', 'anthropic/claude', 'anthropic/claude'],
        ['json_object-fallback model', 'glm/4.6', 'glm/4.6'],
    ])('a clean D promotes identically under a %s (compiledBy carries the model)', async (_label, modelName, expected) => {
        const res = await compileRuleDetector(rule(), compiler(validD), { modelName });
        expect(res.detector).not.toBeNull();
        expect(res.detector!.compiledBy).toBe(expected);
    });
});

// ── issue #1831 acceptance criteria ─────────────────────────────────────────
// Every case below is a shape the incident actually produced, measured against
// 40 real merged PRs from polyglot Ruby repos (evals/kody-rules/
// detector-fp-repro.js). The rule is the real one: a Ruby-scoped "avoid
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
