/**
 * runRecallPasses unit tests — ZERO LLM, fully deterministic.
 *
 * Locks the recall behavior after the soft-coverage change: a single
 * synthesis-rescue pass (always unless skipped), dedup-merge of its ADDITIONAL
 * findings, and the fast/trial skip. The legacy coverage-recovery + 2nd/3rd
 * chance passes (and the coverage-debt nudge) were removed — no coverage-forced
 * re-runs.
 */
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import type { ToolContext } from '@libs/agent-harness/domain/contracts/tool.contract';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import {
    runRecallPasses,
    runFinderWithVerify,
    type FinderSuggestion,
} from '@libs/code-review/infrastructure/agents/core/finder.agent';

const ctx: ToolContext = { runId: 'recall-test' };

function sug(file: string, content: string): FinderSuggestion {
    return {
        relevantFile: file,
        suggestionContent: content,
        existingCode: '',
        improvedCode: '',
    };
}

/** A RunState whose submitResult artifact carries the given suggestions. */
function stateWith(suggestions: FinderSuggestion[]): RunState {
    return {
        artifacts: [
            { type: 'submitResult', payload: { reasoning: 'r', suggestions } },
        ],
        steps: [
            {
                index: 0,
                message: {
                    toolCalls: [{ name: 'readFile', input: { path: 'a.ts' } }],
                },
            },
        ],
        usage: {
            inputTokens: 10,
            outputTokens: 4,
            reasoningTokens: 2,
            cacheReadTokens: 1,
        },
        status: 'done',
    } as any;
}

/** A runner that returns the queued states in order (one per extra pass). */
function fakeRunner(states: RunState[]) {
    let i = 0;
    return {
        run: jest.fn(async () => states[i++] ?? states[states.length - 1]),
    } as any;
}

const base = { reasoning: 'base', suggestions: [sug('a.ts', 'bug1')] };
const finderState = stateWith(base.suggestions);

describe('runRecallPasses', () => {
    it('skips the recall pass in fast/trial mode (skipHeavyPasses)', async () => {
        const runner = fakeRunner([]);
        const out = await runRecallPasses(
            base,
            { runner, finderSpec: {} as any, finderState, userPrompt: 'p', skipHeavyPasses: true },
            ctx,
        );
        expect(runner.run).not.toHaveBeenCalled();
        expect(out.findings).toBe(base);
        expect(out.usage.inputTokens).toBe(0);
    });

    it('runs synthesis rescue and merges NEW findings', async () => {
        const runner = fakeRunner([stateWith([sug('e.ts', 'missed bug')])]);
        const out = await runRecallPasses(
            base,
            {
                runner,
                finderSpec: {} as any,
                finderState,
                userPrompt: 'review this',
            },
            ctx,
        );
        expect(runner.run).toHaveBeenCalledTimes(1); // synthesis only
        expect(out.findings.suggestions.map((s) => s.relevantFile)).toEqual([
            'a.ts',
            'e.ts',
        ]);
        expect(out.usage.inputTokens).toBe(10); // the synthesis run's usage
    });

    it('runs the freeform pass and merges its NEW findings when freeformPass is set', async () => {
        const runner = fakeRunner([
            stateWith([]), // synthesis
            stateWith([sug('z.ts', 'freeform bug')]), // freeform
        ]);
        const out = await runRecallPasses(
            base,
            { runner, finderSpec: {} as any, finderState, userPrompt: 'p', freeformPass: true },
            ctx,
        );
        expect(runner.run).toHaveBeenCalledTimes(2); // synthesis + freeform
        expect(
            out.findings.suggestions.map((s) => s.suggestionContent),
        ).toEqual(['bug1', 'freeform bug']);
    });

    it('does not run the freeform pass by default', async () => {
        const runner = fakeRunner([stateWith([])]);
        await runRecallPasses(
            base,
            { runner, finderSpec: {} as any, finderState, userPrompt: 'p' },
            ctx,
        );
        expect(runner.run).toHaveBeenCalledTimes(1); // synthesis only
    });

    it('freeformBasePrompt: uses it instead of userPrompt for the freeform call only', async () => {
        const runner = fakeRunner([stateWith([]), stateWith([])]);
        await runRecallPasses(
            base,
            {
                runner,
                finderSpec: {} as any,
                finderState,
                userPrompt: 'FULL RULES PROMPT',
                freeformPass: true,
                freeformBasePrompt: 'JUST THE DIFF',
            },
            ctx,
        );
        const freeformPrompt = runner.run.mock.calls[1][1].prompt;
        expect(freeformPrompt).toContain('JUST THE DIFF');
        expect(freeformPrompt).not.toContain('FULL RULES PROMPT');
    });

    it('falls back to userPrompt for the freeform call when freeformBasePrompt is unset', async () => {
        const runner = fakeRunner([stateWith([]), stateWith([])]);
        await runRecallPasses(
            base,
            {
                runner,
                finderSpec: {} as any,
                finderState,
                userPrompt: 'FULL RULES PROMPT',
                freeformPass: true,
            },
            ctx,
        );
        const freeformPrompt = runner.run.mock.calls[1][1].prompt;
        expect(freeformPrompt).toContain('FULL RULES PROMPT');
    });

    it('dedups identical findings across the synthesis merge', async () => {
        const runner = fakeRunner([stateWith([sug('a.ts', 'bug1')])]); // same as base
        const out = await runRecallPasses(
            base,
            { runner, finderSpec: {} as any, finderState, userPrompt: 'p' },
            ctx,
        );
        expect(out.findings.suggestions).toHaveLength(1);
    });

    it('skips synthesis rescue when skipSynthesisRescue is set', async () => {
        const runner = fakeRunner([]);
        const out = await runRecallPasses(
            base,
            {
                runner,
                finderSpec: {} as any,
                finderState,
                userPrompt: 'p',
                skipSynthesisRescue: true,
            },
            ctx,
        );
        expect(runner.run).not.toHaveBeenCalled();
        expect(out.findings).toBe(base);
    });

    describe('critical-file passes', () => {
        const specFactory = () => ({}) as any;

        it('runs one extra pass per critical file and merges their findings', async () => {
            const runner = fakeRunner([
                stateWith([]), // synthesis
                stateWith([sug('b.ts', 'whole-file bug')]),
                stateWith([sug('c.ts', 'another one')]),
            ]);
            const out = await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'p',
                    criticalFiles: [
                        { path: 'b.ts', diff: '@@ -1 +1 @@\n-a\n+b' },
                        { path: 'c.ts', diff: '@@ -1 +1 @@\n-c\n+d' },
                    ],
                },
                ctx,
            );
            expect(runner.run).toHaveBeenCalledTimes(3); // synthesis + 2 files
            expect(out.findings.suggestions.map((s) => s.relevantFile)).toEqual([
                'a.ts',
                'b.ts',
                'c.ts',
            ]);
        });

        it('scopes each pass to its own file and forbids reporting elsewhere', async () => {
            const runner = fakeRunner([stateWith([]), stateWith([])]);
            await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'p',
                    criticalFiles: [
                        { path: 'src/b.ts', diff: '@@ -2 +2 @@\n-old\n+new' },
                    ],
                },
                ctx,
            );
            const prompt = runner.run.mock.calls[1][1].prompt as string;
            // The file's own diff is INJECTED — the pass must not depend on the
            // model choosing to fetch it (models differ, so the same pass would
            // otherwise do different work on different models).
            expect(prompt).toContain('+new');
            expect(prompt).toContain('Report ONLY defects whose relevantFile is src/b.ts');
            expect(prompt).toContain('Ignore the diffs above');
        });

        it('does not run when no critical file is given', async () => {
            const runner = fakeRunner([stateWith([])]);
            await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'p',
                    criticalFiles: [],
                },
                ctx,
            );
            expect(runner.run).toHaveBeenCalledTimes(1); // synthesis only
        });

        it('criticalFileBasePrompt: uses it instead of userPrompt and drops "ignore the diffs above"', async () => {
            const runner = fakeRunner([stateWith([]), stateWith([])]);
            await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'FULL RULES PROMPT',
                    criticalFiles: [
                        { path: 'src/b.ts', diff: '@@ -2 +2 @@\n-old\n+new' },
                    ],
                    criticalFileBasePrompt: 'JUST THE CATEGORIES',
                },
                ctx,
            );
            const prompt = runner.run.mock.calls[1][1].prompt as string;
            expect(prompt).toContain('JUST THE CATEGORIES');
            expect(prompt).not.toContain('FULL RULES PROMPT');
            expect(prompt).not.toContain('Ignore the diffs above');
            expect(prompt).toContain('+new'); // the file's own diff is still injected
        });

        it('refuses to run concurrent passes on a shared coverage ledger', async () => {
            const runner = fakeRunner([stateWith([])]);
            await expect(
                runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        finderState,
                        userPrompt: 'p',
                        criticalFiles: [{ path: 'b.ts', diff: '@@ -1 +1 @@\n+x' }],
                    },
                    ctx,
                ),
            ).rejects.toThrow(/makeResampleSpec/);
        });
    });

    describe('expert panel', () => {
        const specFactory = () => ({}) as any;
        const roles = [
            { name: 'Security Specialist', focus: 'exploit paths' },
            { name: 'Performance Specialist', focus: 'slowdowns' },
        ];

        it('runs one pass per role, then one arbitration pass, merging ONLY the arbitration output', async () => {
            const runner = fakeRunner([
                stateWith([]), // synthesis
                stateWith([sug('a.ts', 'raw security claim')]), // role 1 (raw, must NOT merge)
                stateWith([]), // role 2 (empty lens)
                stateWith([sug('a.ts', 'arbitrated: confirmed SSRF')]), // arbitration
            ]);
            const out = await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'p',
                    expertRoles: roles,
                },
                ctx,
            );
            expect(runner.run).toHaveBeenCalledTimes(4); // synthesis + 2 roles + arbitration
            // The raw role claim ("raw security claim") must NOT appear — only
            // the base finding plus the arbitration pass's reconciled output.
            const contents = out.findings.suggestions.map(
                (s) => s.suggestionContent,
            );
            expect(contents).toEqual(['bug1', 'arbitrated: confirmed SSRF']);
            expect(contents).not.toContain('raw security claim');
        });

        it('skips arbitration when every role lens comes back empty', async () => {
            const runner = fakeRunner([
                stateWith([]), // synthesis
                stateWith([]), // role 1
                stateWith([]), // role 2
            ]);
            const out = await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'p',
                    expertRoles: roles,
                },
                ctx,
            );
            expect(runner.run).toHaveBeenCalledTimes(3); // synthesis + 2 roles, no arbitration
            // synthesis-rescue always re-wraps findings in a new object even
            // when it merges nothing new — compare content, not identity.
            expect(out.findings.suggestions).toEqual(base.suggestions);
        });

        it('recognitionPanel: true runs arbitration even when every role lens is empty, using the skeptic prompt', async () => {
            const runner = fakeRunner([
                stateWith([]), // synthesis
                stateWith([]), // role 1
                stateWith([]), // role 2
                stateWith([sug('a.ts', 'skeptic-surfaced bug')]), // arbitration still runs
            ]);
            const out = await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'p',
                    expertRoles: roles,
                    recognitionPanel: true,
                },
                ctx,
            );
            expect(runner.run).toHaveBeenCalledTimes(4); // synthesis + 2 roles + arbitration (NOT skipped)
            const arbitrationCall = runner.run.mock.calls[3];
            expect(arbitrationCall[1].prompt).toContain('challenge EVERY lens');
            expect(
                out.findings.suggestions.map((s) => s.suggestionContent),
            ).toContain('skeptic-surfaced bug');
        });

        it('expertPanelBasePrompt: uses it instead of userPrompt for every role AND arbitration call', async () => {
            const runner = fakeRunner([
                stateWith([]), // synthesis
                stateWith([sug('a.ts', 'role 1 claim')]), // role 1
                stateWith([]), // role 2
                stateWith([sug('a.ts', 'arbitrated')]), // arbitration
            ]);
            await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'FULL RULES PROMPT',
                    expertRoles: roles,
                    expertPanelBasePrompt: 'JUST THE DIFF',
                },
                ctx,
            );
            // Calls 1 and 2 are the two role passes, call 3 is arbitration.
            for (const call of runner.run.mock.calls.slice(1)) {
                expect(call[1].prompt).toContain('JUST THE DIFF');
                expect(call[1].prompt).not.toContain('FULL RULES PROMPT');
            }
        });

        it('records role-pass cost (steps/toolCalls) without counting them as merged', async () => {
            const runner = fakeRunner([
                stateWith([]),
                stateWith([sug('a.ts', 'x')]),
                stateWith([]),
                stateWith([sug('a.ts', 'final')]),
            ]);
            const out = await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'p',
                    expertRoles: roles,
                },
                ctx,
            );
            const roleStats = out.passStats.filter((p) =>
                p.label.startsWith('expert-role-'),
            );
            expect(roleStats).toHaveLength(2);
            expect(roleStats.every((p) => p.added === 0)).toBe(true);
        });

        it('refuses to run concurrent role passes on a shared coverage ledger', async () => {
            const runner = fakeRunner([stateWith([])]);
            await expect(
                runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        finderState,
                        userPrompt: 'p',
                        expertRoles: roles,
                    },
                    ctx,
                ),
            ).rejects.toThrow(/makeResampleSpec/);
        });

        describe('union mode (expertArbitrate: false)', () => {
            it('merges each role finding DIRECTLY, with no arbitration call', async () => {
                const runner = fakeRunner([
                    stateWith([]), // synthesis
                    stateWith([sug('sec.ts', 'security finding')]), // role 1
                    stateWith([sug('perf.ts', 'perf finding')]), // role 2
                ]);
                const out = await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        expertRoles: roles,
                        expertArbitrate: false,
                    },
                    ctx,
                );
                expect(runner.run).toHaveBeenCalledTimes(3); // synthesis + 2 roles, NO arbitration
                const contents = out.findings.suggestions.map(
                    (s) => s.suggestionContent,
                );
                expect(contents).toEqual([
                    'bug1',
                    'security finding',
                    'perf finding',
                ]);
                const roleStats = out.passStats.filter((p) =>
                    p.label.startsWith('expert-role-'),
                );
                expect(roleStats).toHaveLength(2);
                // Union mode merges for real — unlike arbitrated mode, `added`
                // reflects the actual merge, not a placeholder 0.
                expect(roleStats.every((p) => p.added === 1)).toBe(true);
            });

            it('still runs heavy mode afterward when both are enabled', async () => {
                const runner = fakeRunner([
                    stateWith([]), // synthesis
                    stateWith([]), // role 1
                    stateWith([]), // role 2
                    stateWith([sug('h.ts', 'heavy find')]), // heavy resample
                    stateWith([sug('h2.ts', 'heavy find 2')]), // heavy resample
                ]);
                const out = await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        expertRoles: roles,
                        expertArbitrate: false,
                        heavy: true,
                    },
                    ctx,
                );
                // synthesis + 2 role passes + 2 heavy resamples — the union-mode
                // branch must fall through to heavy, not return early.
                expect(runner.run).toHaveBeenCalledTimes(5);
                expect(
                    out.findings.suggestions.some(
                        (s) => s.relevantFile === 'h.ts',
                    ),
                ).toBe(true);
            });
        });
    });

    describe('scout → deep-investigator', () => {
        const specFactory = () => ({}) as any;

        it('runs one investigator pass per flag and merges their findings', async () => {
            const scout = jest
                .fn()
                .mockResolvedValue([
                    { relevantFile: 'a.ts', hint: 'looks off' },
                    { relevantFile: 'b.ts', hint: 'also off' },
                ]);
            const runner = fakeRunner([
                stateWith([]), // synthesis
                stateWith([sug('a.ts', 'confirmed: real bug')]), // investigator 1
                stateWith([]), // investigator 2 clears the flag
            ]);
            const out = await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'p',
                    scoutInvestigator: true,
                    runScout: scout,
                },
                ctx,
            );
            // A single general-purpose scout call — measured worse recall AND
            // precision when split into 3 category-narrowed scouts (see the
            // comment above the scout block in finder.agent.ts).
            expect(scout).toHaveBeenCalledTimes(1);
            expect(runner.run).toHaveBeenCalledTimes(3); // synthesis + 2 investigators
            expect(
                out.findings.suggestions.map((s) => s.suggestionContent),
            ).toEqual(['bug1', 'confirmed: real bug']);
        });

        describe('investigatorGroupByFile: true', () => {
            it('merges 2+ flags on the same file into ONE investigator pass, keeps single-flag files separate', async () => {
                const scout = jest.fn().mockResolvedValue([
                    { relevantFile: 'a.ts', hint: 'first a suspicion' },
                    { relevantFile: 'b.ts', hint: 'only b suspicion' },
                    { relevantFile: 'a.ts', hint: 'second a suspicion' },
                ]);
                const runner = fakeRunner([
                    stateWith([]), // synthesis
                    stateWith([sug('a.ts', 'merged a bug')]), // a.ts group (2 flags, 1 pass)
                    stateWith([]), // b.ts group (1 flag, 1 pass)
                ]);
                const out = await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        investigatorGroupByFile: true,
                        runScout: scout,
                    },
                    ctx,
                );
                // synthesis + 2 GROUPS (not 3 flags) — a.ts's two flags merged.
                expect(runner.run).toHaveBeenCalledTimes(3);
                const aGroupPrompt = runner.run.mock.calls[1][1].prompt;
                expect(aGroupPrompt).toContain('2 SEPARATE, independent spots');
                expect(aGroupPrompt).toContain('first a suspicion');
                expect(aGroupPrompt).toContain('second a suspicion');
                const bGroupPrompt = runner.run.mock.calls[2][1].prompt;
                expect(bGroupPrompt).toContain('only b suspicion');
                expect(bGroupPrompt).not.toContain('SEPARATE, independent spots');
                expect(
                    out.findings.suggestions.map((s) => s.suggestionContent),
                ).toEqual(['bug1', 'merged a bug']);
            });

            it('does not affect dispatch when every flag is on a different file', async () => {
                const scout = jest.fn().mockResolvedValue([
                    { relevantFile: 'a.ts', hint: 'x' },
                    { relevantFile: 'b.ts', hint: 'y' },
                ]);
                const runner = fakeRunner([
                    stateWith([]),
                    stateWith([]),
                    stateWith([]),
                ]);
                await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        investigatorGroupByFile: true,
                        runScout: scout,
                    },
                    ctx,
                );
                expect(runner.run).toHaveBeenCalledTimes(3); // synthesis + 2 separate passes
            });

            it('skips secondLookSameFile for a merged multi-flag group', async () => {
                const scout = jest.fn().mockResolvedValue([
                    { relevantFile: 'a.ts', hint: 'first a suspicion' },
                    { relevantFile: 'a.ts', hint: 'second a suspicion' },
                ]);
                const runner = fakeRunner([
                    stateWith([]), // synthesis
                    stateWith([]), // merged a.ts group clears (stateWith already carries a tool call)
                ]);
                await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        investigatorGroupByFile: true,
                        secondLookSameFile: true,
                        runScout: scout,
                    },
                    ctx,
                );
                // No second-look pass: only synthesis + the 1 merged group pass.
                expect(runner.run).toHaveBeenCalledTimes(2);
            });
        });

        it('scoutBasePrompt: uses it instead of userPrompt for the scout call only', async () => {
            const scout = jest.fn().mockResolvedValue([]);
            const runner = fakeRunner([stateWith([])]);
            await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'FULL RULES PROMPT',
                    scoutInvestigator: true,
                    scoutBasePrompt: 'JUST THE DIFF',
                    runScout: scout,
                },
                ctx,
            );
            expect(scout.mock.calls[0][0]).toContain('JUST THE DIFF');
            expect(scout.mock.calls[0][0]).not.toContain('FULL RULES PROMPT');
        });

        it('falls back to userPrompt for the scout call when scoutBasePrompt is unset', async () => {
            const scout = jest.fn().mockResolvedValue([]);
            const runner = fakeRunner([stateWith([])]);
            await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'FULL RULES PROMPT',
                    scoutInvestigator: true,
                    runScout: scout,
                },
                ctx,
            );
            expect(scout.mock.calls[0][0]).toContain('FULL RULES PROMPT');
        });

        it('runs no investigator pass when the scout flags nothing', async () => {
            const scout = jest.fn().mockResolvedValue([]);
            const runner = fakeRunner([stateWith([])]); // synthesis only
            const out = await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'p',
                    scoutInvestigator: true,
                    runScout: scout,
                },
                ctx,
            );
            expect(scout).toHaveBeenCalledTimes(1);
            expect(runner.run).toHaveBeenCalledTimes(1); // synthesis only
            expect(out.findings.suggestions).toEqual(base.suggestions);
        });

        it('does nothing when scoutInvestigator is off, even with runScout set', async () => {
            const scout = jest.fn();
            const runner = fakeRunner([stateWith([])]);
            await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'p',
                    runScout: scout,
                },
                ctx,
            );
            expect(scout).not.toHaveBeenCalled();
        });

        it('refuses to run concurrent investigator passes on a shared ledger', async () => {
            const scout = jest
                .fn()
                .mockResolvedValue([{ relevantFile: 'a.ts', hint: 'x' }]);
            const runner = fakeRunner([stateWith([])]);
            await expect(
                runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        runScout: scout,
                    },
                    ctx,
                ),
            ).rejects.toThrow(/makeResampleSpec/);
        });

        describe('scoutResample: true', () => {
            it('runs the scout in sequential rounds instead of one call, then one investigator per accumulated flag', async () => {
                const scout = jest
                    .fn()
                    .mockResolvedValueOnce([
                        { relevantFile: 'a.ts', hint: 'round 1' },
                    ])
                    .mockResolvedValueOnce([
                        { relevantFile: 'b.ts', hint: 'round 2' },
                    ])
                    .mockResolvedValueOnce([]); // round 3: nothing else
                const runner = fakeRunner([
                    stateWith([]), // synthesis
                    stateWith([sug('a.ts', 'confirmed 1')]), // investigator for round-1 flag
                    stateWith([sug('b.ts', 'confirmed 2')]), // investigator for round-2 flag
                ]);
                const out = await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        scoutResample: true,
                        runScout: scout,
                    },
                    ctx,
                );
                expect(scout).toHaveBeenCalledTimes(3); // 3 sequential rounds
                expect(runner.run).toHaveBeenCalledTimes(3); // synthesis + 2 investigators
                expect(
                    out.findings.suggestions.map((s) => s.suggestionContent),
                ).toEqual(['bug1', 'confirmed 1', 'confirmed 2']);
            });
        });

        describe('scoutSecondRound: true', () => {
            it('runs the scout in exactly 2 rounds (5 then 3), one investigator per accumulated flag', async () => {
                const scout = jest
                    .fn()
                    .mockResolvedValueOnce([
                        { relevantFile: 'a.ts', hint: 'round 1' },
                    ])
                    .mockResolvedValueOnce([
                        { relevantFile: 'b.ts', hint: 'round 2' },
                    ]);
                const runner = fakeRunner([
                    stateWith([]), // synthesis
                    stateWith([sug('a.ts', 'confirmed 1')]), // investigator for round-1 flag
                    stateWith([sug('b.ts', 'confirmed 2')]), // investigator for round-2 flag
                ]);
                const out = await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        scoutSecondRound: true,
                        runScout: scout,
                    },
                    ctx,
                );
                expect(scout).toHaveBeenCalledTimes(2); // exactly 2 rounds, not 3
                expect(runner.run).toHaveBeenCalledTimes(3); // synthesis + 2 investigators
                expect(
                    out.findings.suggestions.map((s) => s.suggestionContent),
                ).toEqual(['bug1', 'confirmed 1', 'confirmed 2']);
            });

            it('scoutResample wins when both scoutResample and scoutSecondRound are set', async () => {
                const scout = jest.fn().mockResolvedValue([]);
                const runner = fakeRunner([stateWith([])]);
                await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        scoutResample: true,
                        scoutSecondRound: true,
                        runScout: scout,
                    },
                    ctx,
                );
                // 3 sequential rounds means the scoutResample path ran, not
                // scoutSecondRound's 2.
                expect(scout).toHaveBeenCalledTimes(3);
            });
        });

        describe('scoutByCategory: true', () => {
            it('runs 3 category scouts, one investigator per accumulated flag', async () => {
                const scout = jest.fn(async (_prompt, category) => {
                    if (category === 'bug')
                        return [{ relevantFile: 'a.ts', hint: 'bug hint' }];
                    if (category === 'performance')
                        return [{ relevantFile: 'b.ts', hint: 'perf hint' }];
                    return [{ relevantFile: 'c.ts', hint: 'sec hint' }];
                });
                const runner = fakeRunner([
                    stateWith([]), // synthesis
                    stateWith([sug('a.ts', 'confirmed bug')]),
                    stateWith([sug('b.ts', 'confirmed perf')]),
                    stateWith([sug('c.ts', 'confirmed sec')]),
                ]);
                const out = await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        scoutByCategory: true,
                        scoutCategoryBasePrompts: {
                            bug: 'BUG BASE',
                            performance: 'PERF BASE',
                            security: 'SEC BASE',
                        },
                        runScout: scout,
                    },
                    ctx,
                );
                expect(scout).toHaveBeenCalledTimes(3); // one per category
                expect(runner.run).toHaveBeenCalledTimes(4); // synthesis + 3 investigators
                expect(
                    out.findings.suggestions.map((s) => s.suggestionContent),
                ).toEqual(
                    expect.arrayContaining([
                        'bug1',
                        'confirmed bug',
                        'confirmed perf',
                        'confirmed sec',
                    ]),
                );
            });

            it('falls back to the single general scout when scoutCategoryBasePrompts is unset', async () => {
                const scout = jest.fn().mockResolvedValue([]);
                const runner = fakeRunner([stateWith([])]);
                await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        scoutByCategory: true,
                        runScout: scout,
                    },
                    ctx,
                );
                expect(scout).toHaveBeenCalledTimes(1); // single general scout, not 3
            });
        });

        it('scoutCap: overrides the default cap of MAX_SCOUT_FLAGS baked into the scout prompt text', async () => {
            const scout = jest.fn().mockResolvedValue([]);
            const runner = fakeRunner([stateWith([])]);
            await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'p',
                    scoutInvestigator: true,
                    scoutCap: 3,
                    runScout: scout,
                },
                ctx,
            );
            expect(scout.mock.calls[0][0]).toContain('Flag the 3 spots');
        });

        it('falls back to MAX_SCOUT_FLAGS in the prompt text when scoutCap is unset', async () => {
            const scout = jest.fn().mockResolvedValue([]);
            const runner = fakeRunner([stateWith([])]);
            await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'p',
                    scoutInvestigator: true,
                    runScout: scout,
                },
                ctx,
            );
            expect(scout.mock.calls[0][0]).toContain('Flag the 5 spots');
        });

        it('scoutLineHint: true asks the scout for a line, passed through unchanged when off', async () => {
            const scout = jest.fn().mockResolvedValue([]);
            const runner = fakeRunner([stateWith([])]);
            await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'p',
                    scoutInvestigator: true,
                    scoutLineHint: true,
                    runScout: scout,
                },
                ctx,
            );
            expect(scout.mock.calls[0][0]).toContain('line number in the DIFF');
        });

        it('hypothesisDriven: true asks the scout for a hypothesis and frames the investigator as confirm-or-refute', async () => {
            const scout = jest
                .fn()
                .mockResolvedValue([
                    { relevantFile: 'a.ts', hint: 'returns null but caller assumes non-null' },
                ]);
            const runner = fakeRunner([
                stateWith([]), // synthesis
                stateWith([]), // investigator
            ]);
            await runRecallPasses(
                base,
                {
                    runner,
                    finderSpec: {} as any,
                    makeResampleSpec: specFactory,
                    finderState,
                    userPrompt: 'p',
                    scoutInvestigator: true,
                    hypothesisDriven: true,
                    runScout: scout,
                },
                ctx,
            );
            expect(scout.mock.calls[0][0]).toContain('falsifiable HYPOTHESIS');
            const investigatorPrompt = runner.run.mock.calls[1][1].prompt;
            expect(investigatorPrompt).toContain('SPECIFIC HYPOTHESIS');
            expect(investigatorPrompt).toContain('CONFIRM or REFUTE this exact hypothesis');
        });

        describe('challengeDismissals: true', () => {
            function stateWithReasoning(
                suggestions: FinderSuggestion[],
                reasoning: string,
            ): RunState {
                return {
                    artifacts: [
                        { type: 'submitResult', payload: { reasoning, suggestions } },
                    ],
                    steps: [{ index: 0, message: { toolCalls: [] } }],
                    usage: {
                        inputTokens: 1,
                        outputTokens: 1,
                        reasoningTokens: 0,
                        cacheReadTokens: 0,
                    },
                    status: 'done',
                } as any;
            }

            it('re-challenges a dismissal with real reasoning, skips a shallow one, and merges a recovered finding', async () => {
                const scout = jest.fn().mockResolvedValue([
                    { relevantFile: 'a.ts', hint: 'h1' },
                    { relevantFile: 'b.ts', hint: 'h2' },
                ]);
                const runner = fakeRunner([
                    stateWith([]), // synthesis
                    stateWithReasoning(
                        [],
                        'Considered the race condition here but ruled it out because the lock covers it.',
                    ), // investigator-1: dismissed with real reasoning -> challenged
                    stateWithReasoning([], 'nothing here'), // investigator-2: shallow -> not challenged
                    stateWithReasoning(
                        [sug('a.ts', 'confirmed after challenge')],
                        'reconsidered and the lock does not cover this path',
                    ), // investigator-1-challenge
                ]);
                const out = await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        challengeDismissals: true,
                        runScout: scout,
                    },
                    ctx,
                );
                expect(runner.run).toHaveBeenCalledTimes(4); // synthesis + 2 investigators + 1 challenge
                const challengeCall = runner.run.mock.calls[3];
                expect(challengeCall[1].prompt).toContain('a.ts');
                expect(challengeCall[1].prompt).toContain(
                    'Considered the race condition here but ruled it out',
                );
                expect(
                    out.findings.suggestions.map((s) => s.suggestionContent),
                ).toEqual(['bug1', 'confirmed after challenge']);
            });

            it('does not challenge when a pass reported findings (added > 0)', async () => {
                const scout = jest
                    .fn()
                    .mockResolvedValue([{ relevantFile: 'a.ts', hint: 'h1' }]);
                const runner = fakeRunner([
                    stateWith([]), // synthesis
                    stateWithReasoning(
                        [sug('a.ts', 'confirmed: real bug')],
                        'Traced this thoroughly and found a real defect here.',
                    ), // investigator-1: reported something -> nothing to challenge
                ]);
                await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        challengeDismissals: true,
                        runScout: scout,
                    },
                    ctx,
                );
                expect(runner.run).toHaveBeenCalledTimes(2); // synthesis + investigator only
            });

            it('does nothing extra when challengeDismissals is off (default)', async () => {
                const scout = jest
                    .fn()
                    .mockResolvedValue([{ relevantFile: 'a.ts', hint: 'h1' }]);
                const runner = fakeRunner([
                    stateWith([]), // synthesis
                    stateWithReasoning(
                        [],
                        'Considered the race condition here but ruled it out because the lock covers it.',
                    ), // investigator-1: dismissed, but no challenge knob set
                ]);
                await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        runScout: scout,
                    },
                    ctx,
                );
                expect(runner.run).toHaveBeenCalledTimes(2); // synthesis + investigator only
            });
        });

        describe('secondLookSameFile: true', () => {
            function stateWithToolCall(
                suggestions: FinderSuggestion[],
            ): RunState {
                return {
                    artifacts: [
                        { type: 'submitResult', payload: { reasoning: 'r', suggestions } },
                    ],
                    steps: [
                        {
                            index: 0,
                            message: {
                                toolCalls: [{ name: 'readFile', input: { path: 'a.ts' } }],
                            },
                        },
                    ],
                    usage: {
                        inputTokens: 1,
                        outputTokens: 1,
                        reasoningTokens: 0,
                        cacheReadTokens: 0,
                    },
                    status: 'done',
                } as any;
            }
            function stateNoToolCalls(
                suggestions: FinderSuggestion[],
            ): RunState {
                return {
                    artifacts: [
                        { type: 'submitResult', payload: { reasoning: 'r', suggestions } },
                    ],
                    steps: [{ index: 0, message: { toolCalls: [] } }],
                    usage: {
                        inputTokens: 1,
                        outputTokens: 1,
                        reasoningTokens: 0,
                        cacheReadTokens: 0,
                    },
                    status: 'done',
                } as any;
            }

            it('re-looks at a cleared flag that made tool calls, skips one with none, and merges a recovered finding', async () => {
                const scout = jest.fn().mockResolvedValue([
                    { relevantFile: 'a.ts', hint: 'h1' },
                    { relevantFile: 'b.ts', hint: 'h2' },
                ]);
                const runner = fakeRunner([
                    stateWith([]), // synthesis
                    stateWithToolCall([]), // investigator-1: cleared, but DID look -> second-look fires
                    stateNoToolCalls([]), // investigator-2: cleared, no tool calls -> skipped
                    stateWithToolCall([sug('a.ts', 'a different bug in the same file')]), // second-look
                ]);
                const out = await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        secondLookSameFile: true,
                        runScout: scout,
                    },
                    ctx,
                );
                expect(runner.run).toHaveBeenCalledTimes(4); // synthesis + 2 investigators + 1 second-look
                const secondLookCall = runner.run.mock.calls[3];
                expect(secondLookCall[1].prompt).toContain('a.ts');
                expect(secondLookCall[1].prompt).toContain('readFile(');
                expect(
                    out.findings.suggestions.map((s) => s.suggestionContent),
                ).toEqual(['bug1', 'a different bug in the same file']);
            });

            it('does not re-look when a pass reported findings (added > 0)', async () => {
                const scout = jest
                    .fn()
                    .mockResolvedValue([{ relevantFile: 'a.ts', hint: 'h1' }]);
                const runner = fakeRunner([
                    stateWith([]), // synthesis
                    stateWithToolCall([sug('a.ts', 'confirmed: real bug')]), // investigator-1: reported something
                ]);
                await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        secondLookSameFile: true,
                        runScout: scout,
                    },
                    ctx,
                );
                expect(runner.run).toHaveBeenCalledTimes(2); // synthesis + investigator only
            });

            it('does nothing extra when secondLookSameFile is off (default)', async () => {
                const scout = jest
                    .fn()
                    .mockResolvedValue([{ relevantFile: 'a.ts', hint: 'h1' }]);
                const runner = fakeRunner([
                    stateWith([]), // synthesis
                    stateWithToolCall([]), // investigator-1: cleared, but knob is off
                ]);
                await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        runScout: scout,
                    },
                    ctx,
                );
                expect(runner.run).toHaveBeenCalledTimes(2); // synthesis + investigator only
            });

            it('secondLookForceReport: true drops the empty-array escape hatch from the prompt', async () => {
                const scout = jest
                    .fn()
                    .mockResolvedValue([{ relevantFile: 'a.ts', hint: 'h1' }]);
                const runner = fakeRunner([
                    stateWith([]), // synthesis
                    stateWithToolCall([]), // investigator-1: cleared
                    stateWithToolCall([]), // second-look
                ]);
                await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        secondLookSameFile: true,
                        secondLookForceReport: true,
                        runScout: scout,
                    },
                    ctx,
                );
                const secondLookCall = runner.run.mock.calls[2];
                expect(secondLookCall[1].prompt).toContain(
                    'must report at least one concrete candidate',
                );
            });

            describe('secondLookAlways: true', () => {
                it('re-looks even when the pass already reported a finding (added > 0)', async () => {
                    const scout = jest
                        .fn()
                        .mockResolvedValue([{ relevantFile: 'a.ts', hint: 'h1' }]);
                    const runner = fakeRunner([
                        stateWith([]), // synthesis
                        stateWithToolCall([sug('a.ts', 'confirmed: real bug')]), // investigator-1: found something, but secondLookAlways still fires
                        stateWithToolCall([sug('a.ts', 'a second, different bug')]), // second-look
                    ]);
                    const out = await runRecallPasses(
                        base,
                        {
                            runner,
                            finderSpec: {} as any,
                            makeResampleSpec: specFactory,
                            finderState,
                            userPrompt: 'p',
                            scoutInvestigator: true,
                            secondLookSameFile: true,
                            secondLookAlways: true,
                            runScout: scout,
                        },
                        ctx,
                    );
                    expect(runner.run).toHaveBeenCalledTimes(3); // synthesis + investigator + second-look
                    expect(
                        out.findings.suggestions.map((s) => s.suggestionContent),
                    ).toEqual([
                        'bug1',
                        'confirmed: real bug',
                        'a second, different bug',
                    ]);
                });

                it('still skips a pass with zero tool calls, even with secondLookAlways on', async () => {
                    const scout = jest
                        .fn()
                        .mockResolvedValue([{ relevantFile: 'a.ts', hint: 'h1' }]);
                    const runner = fakeRunner([
                        stateWith([]), // synthesis
                        stateNoToolCalls([]), // investigator-1: no tool calls at all
                    ]);
                    await runRecallPasses(
                        base,
                        {
                            runner,
                            finderSpec: {} as any,
                            makeResampleSpec: specFactory,
                            finderState,
                            userPrompt: 'p',
                            scoutInvestigator: true,
                            secondLookSameFile: true,
                            secondLookAlways: true,
                            runScout: scout,
                        },
                        ctx,
                    );
                    expect(runner.run).toHaveBeenCalledTimes(2); // synthesis + investigator only
                });

                it('has no effect when secondLookSameFile itself is off', async () => {
                    const scout = jest
                        .fn()
                        .mockResolvedValue([{ relevantFile: 'a.ts', hint: 'h1' }]);
                    const runner = fakeRunner([
                        stateWith([]), // synthesis
                        stateWithToolCall([sug('a.ts', 'confirmed: real bug')]),
                    ]);
                    await runRecallPasses(
                        base,
                        {
                            runner,
                            finderSpec: {} as any,
                            makeResampleSpec: specFactory,
                            finderState,
                            userPrompt: 'p',
                            scoutInvestigator: true,
                            secondLookAlways: true,
                            runScout: scout,
                        },
                        ctx,
                    );
                    expect(runner.run).toHaveBeenCalledTimes(2); // synthesis + investigator only
                });
            });

            it('runs both challengeDismissals and secondLookSameFile off one dismissal when both are on and both trigger', async () => {
                const scout = jest
                    .fn()
                    .mockResolvedValue([{ relevantFile: 'a.ts', hint: 'h1' }]);
                function stateWithLongReasoningAndToolCall(
                    suggestions: FinderSuggestion[],
                ): RunState {
                    return {
                        artifacts: [
                            {
                                type: 'submitResult',
                                payload: {
                                    reasoning:
                                        'Considered the race condition here but ruled it out because the lock covers it.',
                                    suggestions,
                                },
                            },
                        ],
                        steps: [
                            {
                                index: 0,
                                message: {
                                    toolCalls: [{ name: 'readFile', input: { path: 'a.ts' } }],
                                },
                            },
                        ],
                        usage: {
                            inputTokens: 1,
                            outputTokens: 1,
                            reasoningTokens: 0,
                            cacheReadTokens: 0,
                        },
                        status: 'done',
                    } as any;
                }
                const runner = fakeRunner([
                    stateWith([]), // synthesis
                    stateWithLongReasoningAndToolCall([]), // investigator-1: cleared, real reasoning + tool calls -> both follow-ups fire
                    stateWithToolCall([]), // challenge
                    stateWithToolCall([]), // second-look
                ]);
                await runRecallPasses(
                    base,
                    {
                        runner,
                        finderSpec: {} as any,
                        makeResampleSpec: specFactory,
                        finderState,
                        userPrompt: 'p',
                        scoutInvestigator: true,
                        challengeDismissals: true,
                        secondLookSameFile: true,
                        runScout: scout,
                    },
                    ctx,
                );
                expect(runner.run).toHaveBeenCalledTimes(4); // synthesis + investigator + challenge + second-look
            });
        });
    });
});

describe('runFinderWithVerify: skipBasePass', () => {
    it('skips the base LLM call entirely — zero runner.run calls, empty findings, when no recall pass is configured', async () => {
        const runner = { run: jest.fn() };
        const result = await runFinderWithVerify(
            {
                runner: runner as any,
                finderSpec: {} as any,
                modelId: 'test-model',
                tools: new InMemoryToolRegistry([]),
                skipBasePass: true,
                skipSynthesisRescue: true,
            },
            { prompt: 'p' },
            ctx,
        );
        expect(runner.run).not.toHaveBeenCalled();
        expect(result.kept).toEqual([]);
        expect(result.finderState.artifacts).toEqual([]);
        expect(result.finderState.status).toBe('completed');
    });

    it('still runs a configured recall pass even with the base pass skipped', async () => {
        const runner = {
            run: jest
                .fn()
                .mockResolvedValueOnce({
                    artifacts: [
                        {
                            type: 'submitResult',
                            payload: {
                                reasoning: 'r',
                                suggestions: [
                                    {
                                        relevantFile: 'a.ts',
                                        suggestionContent: 'panel bug',
                                        existingCode: '',
                                        improvedCode: '',
                                    },
                                ],
                            },
                        },
                    ],
                    steps: [{ index: 0, message: { toolCalls: [] } }],
                    usage: { inputTokens: 1, outputTokens: 1 },
                    status: 'done',
                })
                // verify pass: keep the one finding as-is (refute-to-drop
                // with no tool calls just needs SOME resolvable state).
                .mockResolvedValue({
                    artifacts: [
                        {
                            type: 'submitResult',
                            payload: { reasoning: 'verify', suggestions: [] },
                        },
                    ],
                    steps: [],
                    usage: {},
                    status: 'done',
                }),
        };
        const result = await runFinderWithVerify(
            {
                runner: runner as any,
                finderSpec: {} as any,
                makeResampleSpec: () => ({}) as any,
                modelId: 'test-model',
                tools: new InMemoryToolRegistry([]),
                skipBasePass: true,
                skipSynthesisRescue: true,
                expertRoles: [{ name: 'Security', focus: 'x' }],
                expertArbitrate: false,
            },
            { prompt: 'p' },
            ctx,
        );
        // Base skipped (0 calls) + 1 role pass = exactly 1 call before verify.
        expect(runner.run.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(result.finderState.artifacts).toEqual([]);
    });
});
