import { ClassifySessionUseCase } from './classify-session.use-case';

/**
 * The deterministic core of CLI-session classification: it turns a raw event
 * stream into an aggregated session, and normalizes the model's output before it
 * is stored (clamping confidence, keeping invented scope paths out, typing the
 * decision). These are pure — no repo, no model — so they are exercised directly.
 */
describe('ClassifySessionUseCase — pure aggregation & normalization', () => {
    const uc = new ClassifySessionUseCase({} as any, {} as any);
    const call = (m: string, ...args: any[]) => (uc as any)[m](...args);

    describe('aggregateEvents', () => {
        const ev = (type: string, payload: any = {}) => ({ type, payload });

        it('collects prompts and responses, skipping empty / whitespace-only ones', () => {
            const agg = call('aggregateEvents', [
                ev('turn_start', { turnId: 't1', prompt: 'do X' }),
                ev('turn_start', { turnId: 't2', prompt: '   ' }), // blank → skipped
                ev('turn_end', { turnId: 't1', response: 'done' }),
                ev('turn_end', { turnId: 't2', response: '' }), // blank → skipped
            ]);
            expect(agg.prompts).toEqual(['do X']);
            expect(agg.responses).toEqual(['done']);
        });

        it('parses toolCalls as plain strings OR {toolName|tool, summary} objects', () => {
            const agg = call('aggregateEvents', [
                ev('turn_end', {
                    toolCalls: [
                        'grep',
                        { toolName: 'Read', summary: 'file.ts' },
                        { tool: 'Bash' },
                    ],
                }),
            ]);
            expect(agg.toolCalls).toEqual(['grep', 'Read: file.ts', 'Bash']);
        });

        it('parses filesModified as strings OR {path}, and DEDUPES them', () => {
            const agg = call('aggregateEvents', [
                ev('turn_end', {
                    filesModified: ['a.ts', { path: 'b.ts' }, 'a.ts'],
                }),
            ]);
            expect(agg.filesModified).toEqual(['a.ts', 'b.ts']);
        });

        it('pairs a turn_end with its turn_start by turnId', () => {
            const agg = call('aggregateEvents', [
                ev('turn_start', { turnId: 't1', prompt: 'ask' }),
                ev('turn_end', { turnId: 't1', response: 'reply', toolCalls: ['grep'] }),
            ]);
            expect(agg.turns).toHaveLength(1);
            expect(agg.turns[0]).toMatchObject({
                prompt: 'ask',
                response: 'reply',
                toolCalls: ['grep'],
            });
        });

        it('flushes an orphaned turn_start that never got a turn_end', () => {
            const agg = call('aggregateEvents', [
                ev('turn_start', { turnId: 't1', prompt: 'ask' }),
            ]);
            expect(agg.turns).toHaveLength(1);
            expect(agg.turns[0].prompt).toBe('ask');
        });
    });

    describe('hasUsefulContent — filesRead and commands alone do NOT count', () => {
        const base = {
            prompts: [],
            responses: [],
            toolCalls: [],
            filesModified: [],
            subagents: [],
            filesRead: [],
            commands: [],
        };

        it('is true when any of prompts/responses/toolCalls/filesModified/subagents is present', () => {
            expect(call('hasUsefulContent', { ...base, prompts: ['x'] })).toBe(true);
            expect(call('hasUsefulContent', { ...base, subagents: [{}] })).toBe(true);
        });

        it('is false for an empty session — and for one that only READ files or ran commands', () => {
            expect(call('hasUsefulContent', base)).toBe(false);
            expect(
                call('hasUsefulContent', {
                    ...base,
                    filesRead: ['a.ts'],
                    commands: ['ls'],
                }),
            ).toBe(false);
        });
    });

    describe('inferDecisionType — keyword classification with precedence', () => {
        it.each([
            ['we changed the database schema', 'architectural_decision'],
            ['naming convention for files', 'convention'],
            ['X versus Y, a real tradeoff', 'tradeoff'],
            ['upgrade the claude sdk', 'tooling'],
            ['refactor the jwt middleware', 'implementation_detail'],
            ['just some small talk', 'other'],
        ])('classifies %j as %s', (text, expected) => {
            expect(call('inferDecisionType', text)).toBe(expected);
        });

        it('architectural wins over implementation when both keywords appear', () => {
            // "schema" (architectural) is checked before "implement".
            expect(call('inferDecisionType', 'implement the schema')).toBe(
                'architectural_decision',
            );
        });
    });

    describe('shouldAutoPromote', () => {
        it('promotes ONLY high-confidence architectural / convention / tradeoff decisions', () => {
            expect(call('shouldAutoPromote', 'architectural_decision', 0.7)).toBe(true);
            expect(call('shouldAutoPromote', 'convention', 0.9)).toBe(true);
            expect(call('shouldAutoPromote', 'tradeoff', 0.75)).toBe(true);
        });

        it('does not promote below the 0.7 bar, a non-promotable type, or a non-number confidence', () => {
            expect(call('shouldAutoPromote', 'architectural_decision', 0.69)).toBe(false);
            expect(call('shouldAutoPromote', 'tooling', 0.95)).toBe(false);
            expect(call('shouldAutoPromote', 'convention', undefined)).toBe(false);
        });
    });

    describe('normalizeConfidence — clamp to [0,1]', () => {
        it('clamps out-of-range values and passes valid ones through', () => {
            expect(call('normalizeConfidence', 0.5)).toBe(0.5);
            expect(call('normalizeConfidence', 1.5)).toBe(1);
            expect(call('normalizeConfidence', -0.2)).toBe(0);
        });

        it('returns undefined for non-numbers and NaN', () => {
            expect(call('normalizeConfidence', undefined)).toBeUndefined();
            expect(call('normalizeConfidence', NaN)).toBeUndefined();
            expect(call('normalizeConfidence', 'x')).toBeUndefined();
        });
    });

    describe('normalizePath', () => {
        it('converts back-slashes and strips ./ and leading/trailing slashes', () => {
            expect(call('normalizePath', '.\\src\\a.ts')).toBe('src/a.ts');
            expect(call('normalizePath', '/src/a.ts/')).toBe('src/a.ts');
            expect(call('normalizePath', './a.ts')).toBe('a.ts');
        });

        it('returns "" for a non-string input', () => {
            expect(call('normalizePath', 42)).toBe('');
        });
    });

    describe('normalizeScope — keeps only paths the session actually touched (anti-hallucination)', () => {
        it('drops a model-invented path that is not under any modified file', () => {
            const scope = call(
                'normalizeScope',
                ['src/a.ts', 'made/up.ts'],
                ['src/a.ts'],
            );
            expect(scope).toEqual(['src/a.ts']); // made/up.ts dropped
        });

        it('keeps a directory PREFIX of a modified file', () => {
            expect(call('normalizeScope', ['src'], ['src/a.ts'])).toEqual(['src']);
        });

        it('falls back to the modified files when no requested scope is valid', () => {
            const scope = call(
                'normalizeScope',
                ['totally/invented.ts'],
                ['src/a.ts', 'src/b.ts'],
            );
            expect(scope).toEqual(['src/a.ts', 'src/b.ts']);
        });
    });
});
