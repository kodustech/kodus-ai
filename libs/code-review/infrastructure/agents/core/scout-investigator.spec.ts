import {
    buildScoutPrompt,
    buildScoutFollowUpPrompt,
    buildInvestigatorPrompt,
    buildInvestigatorChallengePrompt,
    buildInvestigatorSecondLookPrompt,
    buildMultiFlagInvestigatorPrompt,
    groupFlagsByFile,
    buildFreeformPrompt,
    runScout,
    runScoutResample,
    runScoutSecondRound,
    runScoutByCategory,
    MAX_SCOUT_FLAGS,
    SCOUT_RESAMPLE_ROUNDS,
    SCOUT_ROUND_CAP,
    CATEGORY_SCOUT_CAP,
} from './scout-investigator';

jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LLM } = require('@libs/llm/llm');

describe('buildScoutPrompt', () => {
    it('wraps the base prompt and caps the ask at MAX_SCOUT_FLAGS', () => {
        const prompt = buildScoutPrompt('BASE PROMPT WITH DIFFS');
        expect(prompt).toContain('BASE PROMPT WITH DIFFS');
        expect(prompt).toContain(String(MAX_SCOUT_FLAGS));
        expect(prompt).toContain('valid, honest answer');
    });

    it('narrows the lens to one category and excludes the others by name', () => {
        const prompt = buildScoutPrompt('BASE', 'security');
        expect(prompt).toContain('Security only');
        expect(prompt).not.toContain('Performance only');
    });

    it('asks for a line anchor only when requestLine is true', () => {
        const withLine = buildScoutPrompt('BASE', undefined, MAX_SCOUT_FLAGS, true);
        const withoutLine = buildScoutPrompt('BASE', undefined, MAX_SCOUT_FLAGS, false);
        expect(withLine).toContain('line number in the DIFF');
        expect(withoutLine).not.toContain('line number in the DIFF');
    });

    it('drops "ignore every rule above" when minimalBase is true (nothing above to ignore)', () => {
        const withRules = buildScoutPrompt('BASE', undefined, MAX_SCOUT_FLAGS, false, false);
        const minimal = buildScoutPrompt('BASE', undefined, MAX_SCOUT_FLAGS, false, true);
        expect(withRules).toContain('Ignore every rule and output format above');
        expect(minimal).not.toContain('Ignore every rule');
        expect(minimal).toContain('You are NOT investigating');
    });

    it('asks for a specific falsifiable hypothesis instead of a vague flag when hypothesisDriven is true', () => {
        const vague = buildScoutPrompt(
            'BASE',
            undefined,
            MAX_SCOUT_FLAGS,
            false,
            false,
            false,
        );
        const hypothesis = buildScoutPrompt(
            'BASE',
            undefined,
            MAX_SCOUT_FLAGS,
            false,
            false,
            true,
        );
        expect(vague).toContain('it does not need to be');
        expect(vague).not.toContain('falsifiable HYPOTHESIS');
        expect(hypothesis).toContain('falsifiable HYPOTHESIS');
        expect(hypothesis).toContain('confirm or refute');
    });
});

describe('buildInvestigatorPrompt', () => {
    it('scopes the pass to the flagged file and hint, and allows clearing it', () => {
        const prompt = buildInvestigatorPrompt('BASE PROMPT', {
            relevantFile: 'app/models/post.rb',
            hint: 'URL now comes from an admin setting, not a constant',
        });
        expect(prompt).toContain('BASE PROMPT');
        expect(prompt).toContain('app/models/post.rb');
        expect(prompt).toContain(
            'URL now comes from an admin setting, not a constant',
        );
        expect(prompt).toContain('submit an empty suggestions array');
    });

    it('anchors to a line when the flag has one, and skips the anchor otherwise', () => {
        const withLine = buildInvestigatorPrompt('BASE', {
            relevantFile: 'app/models/post.rb',
            hint: 'looks off',
            line: 42,
        });
        expect(withLine).toContain('around line 42');

        const withoutLine = buildInvestigatorPrompt('BASE', {
            relevantFile: 'app/models/post.rb',
            hint: 'looks off',
        });
        expect(withoutLine).not.toContain('around line');
    });

    it('warns that not-crashing is not the same as correct, and to read the contract directly', () => {
        const prompt = buildInvestigatorPrompt('BASE', {
            relevantFile: 'app/models/post.rb',
            hint: 'looks off',
        });
        expect(prompt).toContain('A second trap');
        expect(prompt).toContain('does not crash is not the same as');
        expect(prompt).toContain('use grep/findFile to locate that declaration');
        expect(prompt).toContain('what stops running for that input');
    });

    it('frames the task as confirm-or-refute a specific hypothesis when hypothesisDriven is true', () => {
        const normal = buildInvestigatorPrompt(
            'BASE',
            { relevantFile: 'a.rb', hint: 'looks off' },
            false,
        );
        const hypothesis = buildInvestigatorPrompt(
            'BASE',
            { relevantFile: 'a.rb', hint: 'returns null but caller assumes non-null' },
            true,
        );
        expect(normal).toContain('worth a deep, focused look');
        expect(normal).not.toContain('SPECIFIC HYPOTHESIS');
        expect(hypothesis).toContain('SPECIFIC HYPOTHESIS');
        expect(hypothesis).toContain('CONFIRM or REFUTE this exact hypothesis');
        expect(hypothesis).toContain(
            'returns null but caller assumes non-null',
        );
    });
});

describe('groupFlagsByFile', () => {
    it('groups flags by relevantFile, preserving first-seen file and within-file order', () => {
        const flags = [
            { relevantFile: 'a.ts', hint: 'first a' },
            { relevantFile: 'b.ts', hint: 'first b' },
            { relevantFile: 'a.ts', hint: 'second a' },
        ];
        const groups = groupFlagsByFile(flags);
        expect(groups).toEqual([
            [
                { relevantFile: 'a.ts', hint: 'first a' },
                { relevantFile: 'a.ts', hint: 'second a' },
            ],
            [{ relevantFile: 'b.ts', hint: 'first b' }],
        ]);
    });

    it('gives every flag its own single-element group when no file repeats', () => {
        const flags = [
            { relevantFile: 'a.ts', hint: 'x' },
            { relevantFile: 'b.ts', hint: 'y' },
        ];
        expect(groupFlagsByFile(flags)).toEqual([[flags[0]], [flags[1]]]);
    });
});

describe('buildMultiFlagInvestigatorPrompt', () => {
    it('lists every flag as a separate numbered suspicion and asks for equal depth on all', () => {
        const flags = [
            { relevantFile: 'a.ts', hint: 'null deref on line 10' },
            { relevantFile: 'a.ts', hint: 'wrong variable returned', line: 20 },
        ];
        const prompt = buildMultiFlagInvestigatorPrompt('BASE', flags);
        expect(prompt).toContain('BASE');
        expect(prompt).toContain('2 SEPARATE, independent spots');
        expect(prompt).toContain('1. null deref on line 10');
        expect(prompt).toContain('2. wrong variable returned (around line 20 in the diff)');
        expect(prompt).toContain('same depth and rigor');
        expect(prompt).toContain('does not excuse skimming the rest');
        expect(prompt).toContain('A second trap');
        expect(prompt).toContain('file="a.ts"');
    });
});

describe('buildInvestigatorChallengePrompt', () => {
    it('feeds back the prior reasoning and asks it to argue the opposite case', () => {
        const prompt = buildInvestigatorChallengePrompt(
            'BASE PROMPT',
            { relevantFile: 'app/models/post.rb', hint: 'looks off' },
            'I checked the lock and it covers this path, so no bug.',
        );
        expect(prompt).toContain('BASE PROMPT');
        expect(prompt).toContain('app/models/post.rb');
        expect(prompt).toContain(
            'I checked the lock and it covers this path, so no bug.',
        );
        expect(prompt).toContain('argue the OPPOSITE case');
        expect(prompt).toContain('submit an empty suggestions array');
    });
});

describe('buildInvestigatorSecondLookPrompt', () => {
    it('recaps the prior tool-call trail and asks about a DIFFERENT defect in the same file', () => {
        const prompt = buildInvestigatorSecondLookPrompt(
            'BASE PROMPT',
            { relevantFile: 'app/models/post.rb', hint: 'looks off' },
            'readFile(app/models/post.rb)\ngrep(publish)',
        );
        expect(prompt).toContain('BASE PROMPT');
        expect(prompt).toContain('app/models/post.rb');
        expect(prompt).toContain('readFile(app/models/post.rb)');
        expect(prompt).toContain('Forget that original suspicion');
        expect(prompt).toContain('submit an empty suggestions array');
    });

    it('forceReport: true removes the empty-array escape hatch', () => {
        const prompt = buildInvestigatorSecondLookPrompt(
            'BASE PROMPT',
            { relevantFile: 'app/models/post.rb', hint: 'looks off' },
            'readFile(app/models/post.rb)',
            true,
        );
        expect(prompt).toContain('must report at least one concrete candidate');
        expect(prompt).not.toContain('submit an empty suggestions array');
    });
});

describe('runScout', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns the flags LLM.run produced', async () => {
        LLM.run.mockResolvedValue({
            flags: [{ relevantFile: 'a.rb', hint: 'looks off' }],
        });
        const flags = await runScout('prompt', undefined, 'org-1', 'run-1');
        expect(flags).toEqual([{ relevantFile: 'a.rb', hint: 'looks off' }]);
        expect(LLM.run).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: 'org-1',
                runName: 'run-1-scout',
                user: 'prompt',
            }),
        );
    });

    it('hard-caps flags at MAX_SCOUT_FLAGS regardless of prompt compliance', async () => {
        LLM.run.mockResolvedValue({
            flags: Array.from({ length: 20 }, (_, i) => ({
                relevantFile: `f${i}.rb`,
                hint: 'x',
            })),
        });
        const flags = await runScout('prompt', undefined, undefined);
        expect(flags).toHaveLength(MAX_SCOUT_FLAGS);
    });

    it('degrades to no flags — never throws — on a broken call', async () => {
        LLM.run.mockRejectedValue(new Error('boom'));
        await expect(
            runScout('prompt', undefined, undefined),
        ).resolves.toEqual([]);
    });

    it('honors a custom cap', async () => {
        LLM.run.mockResolvedValue({
            flags: Array.from({ length: 5 }, (_, i) => ({
                relevantFile: `f${i}.rb`,
                hint: 'x',
            })),
        });
        const flags = await runScout('prompt', undefined, undefined, undefined, undefined, 2);
        expect(flags).toHaveLength(2);
    });

    it('tags each flag with its category and namespaces the run name', async () => {
        LLM.run.mockResolvedValue({
            flags: [{ relevantFile: 'a.py', hint: 'N+1 in a loop' }],
        });
        const flags = await runScout(
            'prompt',
            undefined,
            undefined,
            'run-1',
            'performance',
        );
        expect(flags).toEqual([
            { relevantFile: 'a.py', hint: 'N+1 in a loop', category: 'performance' },
        ]);
        expect(LLM.run).toHaveBeenCalledWith(
            expect.objectContaining({ runName: 'run-1-scout-performance' }),
        );
    });

    it('passes reasoningEffort as providerOptions.openai when given, omits it otherwise', async () => {
        LLM.run.mockResolvedValue({ flags: [] });
        await runScout('prompt', undefined, undefined, undefined, undefined, undefined, 'medium');
        expect(LLM.run).toHaveBeenCalledWith(
            expect.objectContaining({
                providerOptions: { openai: { reasoningEffort: 'medium' } },
            }),
        );

        LLM.run.mockClear();
        await runScout('prompt', undefined, undefined);
        expect(LLM.run).toHaveBeenCalledWith(
            expect.not.objectContaining({ providerOptions: expect.anything() }),
        );
    });
});

describe('buildScoutFollowUpPrompt', () => {
    it('lists already-flagged spots and asks for OTHERS, not paraphrases', () => {
        const prompt = buildScoutFollowUpPrompt(
            'BASE',
            [{ relevantFile: 'a.rb', hint: 'looks off' }],
            3,
        );
        expect(prompt).toContain('a.rb — looks off');
        expect(prompt).toContain('OTHER spots');
        expect(prompt).toContain('Do not restate, rephrase');
    });

    it('handles an empty already-flagged list', () => {
        const prompt = buildScoutFollowUpPrompt('BASE', [], 3);
        expect(prompt).toContain('nothing flagged yet');
    });
});

describe('runScoutResample', () => {
    it('runs SCOUT_RESAMPLE_ROUNDS sequential rounds, each capped, accumulating flags', async () => {
        const scout = jest
            .fn()
            .mockResolvedValueOnce([{ relevantFile: 'a.rb', hint: 'r1' }])
            .mockResolvedValueOnce([{ relevantFile: 'b.rb', hint: 'r2' }])
            .mockResolvedValueOnce([{ relevantFile: 'c.rb', hint: 'r3' }]);

        const flags = await runScoutResample(scout, 'BASE PROMPT');

        expect(scout).toHaveBeenCalledTimes(SCOUT_RESAMPLE_ROUNDS);
        // Every call is capped at SCOUT_ROUND_CAP, not MAX_SCOUT_FLAGS.
        for (const call of scout.mock.calls) {
            expect(call[2]).toBe(SCOUT_ROUND_CAP);
        }
        expect(flags).toEqual([
            { relevantFile: 'a.rb', hint: 'r1' },
            { relevantFile: 'b.rb', hint: 'r2' },
            { relevantFile: 'c.rb', hint: 'r3' },
        ]);
    });

    it('round 2+ prompts include what round 1 already flagged', async () => {
        const scout = jest
            .fn()
            .mockResolvedValueOnce([{ relevantFile: 'a.rb', hint: 'first find' }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);

        await runScoutResample(scout, 'BASE PROMPT');

        const round2Prompt = scout.mock.calls[1][0];
        expect(round2Prompt).toContain('a.rb — first find');
    });
});

describe('runScoutSecondRound', () => {
    it('round 1 stays at MAX_SCOUT_FLAGS, round 2 is capped at SCOUT_ROUND_CAP', async () => {
        const scout = jest
            .fn()
            .mockResolvedValueOnce([
                { relevantFile: 'a.rb', hint: 'r1a' },
                { relevantFile: 'b.rb', hint: 'r1b' },
            ])
            .mockResolvedValueOnce([{ relevantFile: 'c.rb', hint: 'r2' }]);

        const flags = await runScoutSecondRound(scout, 'BASE PROMPT');

        expect(scout).toHaveBeenCalledTimes(2);
        expect(scout.mock.calls[0][2]).toBe(MAX_SCOUT_FLAGS);
        expect(scout.mock.calls[1][2]).toBe(SCOUT_ROUND_CAP);
        expect(flags).toEqual([
            { relevantFile: 'a.rb', hint: 'r1a' },
            { relevantFile: 'b.rb', hint: 'r1b' },
            { relevantFile: 'c.rb', hint: 'r2' },
        ]);
    });

    it('round 2 prompt includes what round 1 already flagged', async () => {
        const scout = jest
            .fn()
            .mockResolvedValueOnce([{ relevantFile: 'a.rb', hint: 'first find' }])
            .mockResolvedValueOnce([]);

        await runScoutSecondRound(scout, 'BASE PROMPT');

        const round2Prompt = scout.mock.calls[1][0];
        expect(round2Prompt).toContain('a.rb — first find');
    });

    it('round 2 can return empty — final flags are round 1 only', async () => {
        const scout = jest
            .fn()
            .mockResolvedValueOnce([{ relevantFile: 'a.rb', hint: 'r1' }])
            .mockResolvedValueOnce([]);

        const flags = await runScoutSecondRound(scout, 'BASE PROMPT');

        expect(flags).toEqual([{ relevantFile: 'a.rb', hint: 'r1' }]);
    });
});

describe('runScoutByCategory', () => {
    it('runs 3 parallel scouts, one per category, each with its own base and CATEGORY_SCOUT_CAP', async () => {
        const scout = jest.fn(async (_prompt, category, _cap) => {
            if (category === 'bug') return [{ relevantFile: 'a.ts', hint: 'bug hint' }];
            if (category === 'performance')
                return [{ relevantFile: 'b.ts', hint: 'perf hint' }];
            return [{ relevantFile: 'c.ts', hint: 'sec hint' }];
        });
        const bases = {
            bug: 'BUG DIFF+DEFS',
            performance: 'PERF DIFF+DEFS',
            security: 'SEC DIFF+DEFS',
        };

        const flags = await runScoutByCategory(scout as any, bases);

        expect(scout).toHaveBeenCalledTimes(3);
        const calledCategories = scout.mock.calls.map((c) => c[1]).sort();
        expect(calledCategories).toEqual(['bug', 'performance', 'security']);
        for (const call of scout.mock.calls) {
            expect(call[2]).toBe(CATEGORY_SCOUT_CAP);
        }
        const bugCall = scout.mock.calls.find((c) => c[1] === 'bug');
        expect(bugCall![0]).toContain('BUG DIFF+DEFS');
        expect(bugCall![0]).not.toContain('PERF DIFF+DEFS');
        // Category tagging is runScout's own job (tested separately) — this
        // function just merges whatever each scout call returns.
        expect(flags).toEqual(
            expect.arrayContaining([
                { relevantFile: 'a.ts', hint: 'bug hint' },
                { relevantFile: 'b.ts', hint: 'perf hint' },
                { relevantFile: 'c.ts', hint: 'sec hint' },
            ]),
        );
    });

    it('respects a custom cap', async () => {
        const scout = jest.fn().mockResolvedValue([]);
        const bases = { bug: 'b', performance: 'p', security: 's' };

        await runScoutByCategory(scout as any, bases, 7);

        for (const call of scout.mock.calls) {
            expect(call[2]).toBe(7);
        }
    });
});

describe('buildFreeformPrompt', () => {
    it('keeps the anchoring rule, the shape-based category guide and the mechanism bar', () => {
        const prompt = buildFreeformPrompt('BASE PROMPT WITH DIFFS');
        expect(prompt).toContain('BASE PROMPT WITH DIFFS');
        expect(prompt).toContain('anchored to a line this diff added or changed');
        expect(prompt).toContain('senior engineer');
        expect(prompt).toContain('empty suggestions array');
        expect(prompt).toContain('concrete MECHANISM');
        expect(prompt).toContain('Logic/correctness bugs');
        expect(prompt).toContain('Security flaws');
        expect(prompt).toContain('Performance regressions');
        expect(prompt).toContain('Ignore every rule and output format above');
    });

    it('drops the dead "ignore every rule above" line when base is already minimal', () => {
        const prompt = buildFreeformPrompt('DIFF ONLY, NO RULES', true);
        expect(prompt).toContain('DIFF ONLY, NO RULES');
        expect(prompt).toContain('anchored to a line this diff added or changed');
        expect(prompt).not.toContain('Ignore every rule and output format above');
    });
});
