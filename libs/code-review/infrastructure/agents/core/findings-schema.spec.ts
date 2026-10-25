jest.mock('@libs/core/log/logger', () => ({
    createLogger: jest.fn(() => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    })),
}));

import { createLogger } from '@libs/core/log/logger';
import {
    sanitizeFindingsResult,
    type FindingsOutput,
} from '@libs/code-review/infrastructure/agents/core/findings-schema';

// findings-schema.ts calls createLogger('FindingsSchema') exactly once at
// module load — this is that one instance, stable for the whole file.
const mockLogger = (createLogger as jest.Mock).mock.results[0].value;

describe('sanitizeFindingsResult', () => {
    beforeEach(() => {
        mockLogger.warn.mockClear();
    });

    it('keeps a repo_instruction finding', () => {
        const result = sanitizeFindingsResult({
            reasoning: 'r',
            suggestions: [
                {
                    relevantFile: 'src/a.ts',
                    label: 'repo_instruction',
                    suggestionContent: 'CLAUDE.md says: use the logger.',
                    existingCode: 'console.log(x)',
                    improvedCode: 'logger.info(x)',
                },
            ],
        } as FindingsOutput);

        expect(result?.suggestions[0]?.label).toBe('repo_instruction');
    });

    it('keeps a finding whose label is off the list, for the label step to fix', () => {
        const result = sanitizeFindingsResult({
            reasoning: 'r',
            suggestions: [
                {
                    relevantFile: 'src/a.ts',
                    label: 'criticism',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 2,
                    suggestionContent: 'The total ignores refunds.',
                },
            ],
        } as unknown as FindingsOutput);

        expect(result?.suggestions).toHaveLength(1);
        expect(result?.suggestions[0]?.label).toBe('criticism');
    });

    it('returns null when given null', () => {
        expect(sanitizeFindingsResult(null)).toBeNull();
    });

    it('returns validated data for a valid FindingsOutput', () => {
        const valid: FindingsOutput = {
            reasoning: 'found a bug',
            suggestions: [
                {
                    relevantFile: 'src/foo.ts',
                    suggestionContent: 'Fix the null check',
                    existingCode: 'if (x)',
                    improvedCode: 'if (x != null)',
                },
            ],
        };
        const result = sanitizeFindingsResult(valid);
        expect(result).not.toBeNull();
        expect(result!.reasoning).toBe('found a bug');
        expect(result!.suggestions).toHaveLength(1);
        expect(result!.suggestions[0].relevantFile).toBe('src/foo.ts');
    });

    it('returns null when suggestions is missing entirely', () => {
        const malformed = { reasoning: 'some text' } as any;
        expect(sanitizeFindingsResult(malformed)).toBeNull();
    });

    it('returns null when suggestions is undefined', () => {
        const malformed = {
            reasoning: 'some text',
            suggestions: undefined,
        } as any;
        expect(sanitizeFindingsResult(malformed)).toBeNull();
    });

    it('returns null when suggestions is a string instead of array', () => {
        const malformed = {
            reasoning: 'some text',
            suggestions: 'not an array',
        } as any;
        expect(sanitizeFindingsResult(malformed)).toBeNull();
    });

    it('recovers suggestions sent as a JSON-encoded string (Claude tool calls)', () => {
        const item = {
            relevantFile: 'src/foo.ts',
            suggestionContent: 'Fix the null check',
            existingCode: 'if (x)',
            improvedCode: 'if (x != null)',
        };
        const result = sanitizeFindingsResult({
            reasoning: 'found a bug',
            suggestions: JSON.stringify([item]),
        } as any);
        expect(result).not.toBeNull();
        expect(result!.suggestions).toEqual([item]);
        expect(mockLogger.warn.mock.calls[0][0].message).toContain(
            'recovered an off-shape findings payload',
        );
    });

    it('recovers a stringified array whose items carry markdown code fences', () => {
        const item = {
            relevantFile: 'src/foo.ts',
            suggestionContent: 'Use a guard:\n```ts\nif (x != null) {}\n```',
            existingCode: 'if (x)',
            improvedCode: 'if (x != null)',
        };
        const result = sanitizeFindingsResult({
            reasoning: 'r',
            suggestions: JSON.stringify([item]),
        } as any);
        expect(result!.suggestions).toEqual([item]);
    });

    it('keeps a finding that omits improvedCode / existingCode or sends null', () => {
        const result = sanitizeFindingsResult({
            reasoning: 'r',
            suggestions: [
                { relevantFile: 'a.ts', suggestionContent: 'bug A', existingCode: 'x' },
                { relevantFile: 'b.ts', suggestionContent: 'bug B', relevantLinesStart: 3, relevantLinesEnd: 4, existingCode: null, improvedCode: null },
            ],
        } as any);
        expect(result!.suggestions).toHaveLength(2);
        expect(result!.suggestions[0].improvedCode).toBe('');
        expect(result!.suggestions[1].existingCode).toBe('');
    });

    it('uses oneSentenceSummary when suggestionContent is missing', () => {
        const result = sanitizeFindingsResult({
            reasoning: 'r',
            suggestions: [{ relevantFile: 'a.ts', oneSentenceSummary: 'null deref in foo', existingCode: 'x', improvedCode: 'y' }],
        } as any);
        expect(result!.suggestions[0].suggestionContent).toBe('null deref in foo');
    });

    it('normalizes severity case and clears an unknown severity instead of dropping', () => {
        const result = sanitizeFindingsResult({
            reasoning: 'r',
            suggestions: [
                { relevantFile: 'a.ts', suggestionContent: 'A', existingCode: 'x', improvedCode: 'y', severity: 'High' },
                { relevantFile: 'b.ts', suggestionContent: 'B', existingCode: 'x', improvedCode: 'y', severity: 'info' },
            ],
        } as any);
        expect(result!.suggestions).toHaveLength(2);
        expect(result!.suggestions[0].severity).toBe('high');
        expect(result!.suggestions[1].severity).toBeUndefined();
    });

    it('leaves a JSON-encoded non-array suggestions string to fail as before', () => {
        const result = sanitizeFindingsResult({
            reasoning: 'x',
            suggestions: JSON.stringify({ not: 'an array' }),
        } as any);
        expect(result).toBeNull();
    });

    it('partially recovers when reasoning is missing but suggestions is a valid array', () => {
        const partial = {
            suggestions: [
                {
                    relevantFile: 'src/bar.ts',
                    suggestionContent: 'Fix this',
                    existingCode: 'old',
                    improvedCode: 'new',
                },
            ],
        } as any;
        const result = sanitizeFindingsResult(partial);
        expect(result).not.toBeNull();
        expect(result!.reasoning).toBe('');
        expect(result!.suggestions).toHaveLength(1);
    });

    it('returns validated data with empty suggestions array', () => {
        const empty: FindingsOutput = {
            reasoning: 'no issues found',
            suggestions: [],
        };
        const result = sanitizeFindingsResult(empty);
        expect(result).not.toBeNull();
        expect(result!.suggestions).toEqual([]);
    });

    // Regression: prod audit (2026-09-17) of 619 [LLM_ENVELOPE] events found
    // ~150 were an otherwise-fully-valid suggestion dropped ONLY because the
    // model's self-reported `confidence` fell outside [1,10] (commonly 0).
    // `confidence` is telemetry, never trustworthy input (see review-finding.ts
    // doc comment) — an out-of-range value must not discard a real finding.
    it('keeps a suggestion whose self-reported confidence is 0 (out of the documented 1-10 range)', () => {
        const withZeroConfidence = {
            reasoning: 'found a bug',
            suggestions: [
                {
                    relevantFile: 'src/foo.ts',
                    suggestionContent: 'Fix the null check',
                    existingCode: 'if (x)',
                    improvedCode: 'if (x != null)',
                    confidence: 0,
                },
            ],
        } as any;
        const result = sanitizeFindingsResult(withZeroConfidence);
        expect(result).not.toBeNull();
        expect(result!.suggestions).toHaveLength(1);
        expect(result!.suggestions[0].confidence).toBe(0);
    });

    it('keeps a suggestion whose self-reported confidence exceeds 10', () => {
        const withOverConfidence = {
            reasoning: 'found a bug',
            suggestions: [
                {
                    relevantFile: 'src/foo.ts',
                    suggestionContent: 'Fix the null check',
                    existingCode: 'if (x)',
                    improvedCode: 'if (x != null)',
                    confidence: 42,
                },
            ],
        } as any;
        const result = sanitizeFindingsResult(withOverConfidence);
        expect(result).not.toBeNull();
        expect(result!.suggestions).toHaveLength(1);
    });

    // Backward compatibility: every test above calls sanitizeFindingsResult
    // with ONE argument (the pre-existing call shape, still used everywhere
    // this session didn't touch). None of them mock the logger and all still
    // pass, which already proves the added param breaks no existing caller.
    // This test makes that explicit and pins the no-crash contract too.
    it('still works when called with no telemetryMetadata at all (pre-existing call shape)', () => {
        const malformed = {
            reasoning: 'x',
            suggestions: 'not-an-array',
        } as any;
        let result: FindingsOutput | null = null;
        expect(() => {
            result = sanitizeFindingsResult(malformed);
        }).not.toThrow();
        expect(result).toBeNull();
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(
            mockLogger.warn.mock.calls[0][0].metadata.organizationId,
        ).toBeUndefined();
    });

    // Regression (prod audit 2026-09-17): this file logged no organizationId
    // at all, so a bucket like "594 dropped-suggestion events" could never be
    // attributed to 1 org vs many. Both [LLM_ENVELOPE] warn call sites must
    // carry it end-to-end when the caller supplies it, and must not throw or
    // change behavior when the caller doesn't.
    describe('organizationId threading (observability only, zero behavior change)', () => {
        it('attaches organizationId to the schema-validation-failed warn', () => {
            const malformed = {
                reasoning: 'x',
                suggestions: 'not-an-array',
            } as any;

            const result = sanitizeFindingsResult(malformed, {
                organizationId: 'org-123',
            });

            expect(result).toBeNull(); // behavior unchanged
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            const [{ metadata }] = mockLogger.warn.mock.calls[0];
            expect(metadata.organizationId).toBe('org-123');
        });

        it('attaches organizationId to the dropped-suggestion warn, without changing which suggestions survive', () => {
            const mixed = {
                reasoning: 'x',
                suggestions: [
                    {
                        relevantFile: 'src/a.ts',
                        suggestionContent: 'ok',
                        existingCode: 'a',
                        improvedCode: 'b',
                    },
                    { totally: 'invalid' },
                ],
            } as any;

            const result = sanitizeFindingsResult(mixed, {
                organizationId: 'org-456',
            });

            expect(result!.suggestions).toHaveLength(1); // same as without metadata
            expect(mockLogger.warn).toHaveBeenCalledTimes(1); // one drop log per artifact (#2112)
            const droppedCall = mockLogger.warn.mock.calls[0][0];
            expect(droppedCall.metadata.organizationId).toBe('org-456');
            expect(droppedCall.metadata.dropped).toBe(1);
        });

        it('does not attach organizationId when the caller omits telemetryMetadata', () => {
            const malformed = {
                reasoning: 'x',
                suggestions: 'not-an-array',
            } as any;

            sanitizeFindingsResult(malformed);

            const [{ metadata }] = mockLogger.warn.mock.calls[0];
            expect(metadata.organizationId).toBeUndefined();
        });
    });
});

// #2112 — what non-strict providers actually send in submitResult. Fixtures use
// an invented shop domain.
describe('sanitizeFindingsResult — provider shapes (#2112)', () => {
    const finding = (over: Record<string, unknown> = {}) => ({
        relevantFile: 'src/cart/totals.ts',
        suggestionContent: 'Discount is applied twice when the coupon repeats',
        existingCode: 'total -= discount',
        improvedCode: 'total -= once(discount)',
        ...over,
    });
    const run = (raw: unknown, meta?: Record<string, string>) =>
        sanitizeFindingsResult(raw, meta);

    beforeEach(() => mockLogger.warn.mockClear());

    describe('item rules', () => {
        it('FPARSE-10 — null on an optional field reads as absent', () => {
            const r = run({
                reasoning: 'r',
                suggestions: [
                    finding({
                        ruleUuid: null,
                        revisesSuggestionId: null,
                        label: null,
                    }),
                ],
            });
            expect(r!.suggestions).toHaveLength(1);
            expect(r!.suggestions[0].ruleUuid).toBeUndefined();
            expect(r!.suggestions[0].revisesSuggestionId).toBeUndefined();
        });

        it('FPARSE-11 — absent or null fix fields keep the finding with empty code', () => {
            const r = run({
                reasoning: 'r',
                suggestions: [
                    finding({
                        existingCode: undefined,
                        improvedCode: undefined,
                        relevantLinesStart: 12,
                        relevantLinesEnd: 14,
                    }),
                    finding({ improvedCode: null }),
                ],
            });
            expect(r!.suggestions).toHaveLength(2);
            expect(r!.suggestions[0].existingCode).toBe('');
            expect(r!.suggestions[0].improvedCode).toBe('');
            expect(r!.suggestions[1].improvedCode).toBe('');
        });

        it('FPARSE-19 — a finding sent without existingCode and without lines is dropped as missing-location', () => {
            const r = run({
                reasoning: 'r',
                suggestions: [
                    finding({ existingCode: undefined }),
                    finding({
                        existingCode: undefined,
                        relevantLinesStart: 12,
                    }),
                    // Line 0 reads as no line to the diff snap (snapLinesToDiff).
                    finding({
                        existingCode: undefined,
                        relevantLinesStart: 0,
                        relevantLinesEnd: 0,
                    }),
                    finding({
                        existingCode: undefined,
                        relevantLinesStart: '0',
                        relevantLinesEnd: '0',
                    }),
                    finding({
                        existingCode: null,
                        relevantLinesStart: 12,
                        relevantLinesEnd: 14,
                    }),
                ],
            });
            expect(r!.suggestions).toHaveLength(1);
            const { drops } = mockLogger.warn.mock.calls[0][0].metadata;
            expect(drops.map((d: any) => d.reason)).toEqual([
                'missing-location',
                'missing-location',
                'missing-location',
                'missing-location',
            ]);
        });

        it('FPARSE-25 — a finding sent without existingCode loses its fix; an explicit empty existingCode keeps it', () => {
            const at = { relevantLinesStart: 12, relevantLinesEnd: 14 };
            const r = run({
                reasoning: 'r',
                suggestions: [
                    finding({ ...at, existingCode: undefined }),
                    finding({ ...at, existingCode: '' }),
                    finding({ existingCode: '' }),
                ],
            });
            expect(r!.suggestions.map((s) => s.improvedCode)).toEqual([
                '',
                'total -= once(discount)',
                'total -= once(discount)',
            ]);
        });

        it('FPARSE-12 — enum casing is normalized', () => {
            const r = run({
                reasoning: 'r',
                suggestions: [finding({ severity: 'High', label: ' BUG ' })],
            });
            expect(r!.suggestions[0].severity).toBe('high');
            expect(r!.suggestions[0].label).toBe('bug');
        });

        it('FPARSE-13 — an unknown severity clears the field and keeps the finding', () => {
            const r = run({
                reasoning: 'r',
                suggestions: [finding({ severity: 'urgent', label: 'style' })],
            });
            expect(r!.suggestions).toHaveLength(1);
            expect(r!.suggestions[0].severity).toBeUndefined();
            // Any label reaches the stage, which turns it into `bug` (#1821).
            expect(r!.suggestions[0].label).toBe('style');
        });

        it('FPARSE-14 — numeric strings become numbers; other strings clear the field', () => {
            const r = run({
                reasoning: 'r',
                suggestions: [
                    finding({
                        relevantLinesStart: '12',
                        relevantLinesEnd: ' 14 ',
                        confidence: 'eight',
                    }),
                ],
            });
            expect(r!.suggestions[0].relevantLinesStart).toBe(12);
            expect(r!.suggestions[0].relevantLinesEnd).toBe(14);
            expect(r!.suggestions[0].confidence).toBeUndefined();
        });

        it('FPARSE-15 — missing/empty relevantFile or missing/null/blank suggestionContent drops the item', () => {
            const r = run({
                reasoning: 'r',
                suggestions: [
                    finding(),
                    finding({ relevantFile: undefined }),
                    finding({ relevantFile: '' }),
                    finding({ suggestionContent: undefined }),
                    finding({ suggestionContent: null }),
                    finding({ suggestionContent: '   ' }),
                ],
            });
            expect(r!.suggestions).toHaveLength(1);
            const { drops } = mockLogger.warn.mock.calls[0][0].metadata;
            expect(drops.map((d: any) => d.reason)).toEqual([
                'missing-relevantFile',
                'missing-relevantFile',
                'missing-suggestionContent',
                'missing-suggestionContent',
                'missing-suggestionContent',
            ]);
        });

        it('FPARSE-16 — a MiniMax {"$text"} node is dropped as provider-text-node', () => {
            const r = run({
                reasoning: 'r',
                suggestions: [
                    finding({ suggestionContent: undefined }),
                    { $text: '42' },
                    { $text: 'total -= once(discount)' },
                ],
            });
            expect(r!.suggestions).toEqual([]);
            const { drops } = mockLogger.warn.mock.calls[0][0].metadata;
            expect(drops.map((d: any) => d.reason)).toEqual([
                'missing-suggestionContent',
                'provider-text-node',
                'provider-text-node',
            ]);
        });

        it('FPARSE-17 — a non-object item is dropped as non-object with its type', () => {
            run({
                reasoning: 'r',
                suggestions: [
                    finding(),
                    'src/cart/totals.ts: discount twice',
                    7,
                    '{"a":1}',
                ],
            });
            const { drops } = mockLogger.warn.mock.calls[0][0].metadata;
            expect(drops).toEqual([
                expect.objectContaining({
                    reason: 'non-object',
                    type: 'string',
                    parsesAsObject: false,
                }),
                expect.objectContaining({
                    reason: 'non-object',
                    type: 'number',
                    parsesAsObject: false,
                }),
                expect.objectContaining({
                    reason: 'non-object',
                    type: 'string',
                    parsesAsObject: true,
                }),
            ]);
        });
    });

    describe('envelope rules', () => {
        it('FPARSE-01 — suggestions sent as JSON text are parsed', () => {
            const r = run({
                reasoning: 'r',
                suggestions: JSON.stringify([finding(), finding()]),
            });
            expect(r!.suggestions).toHaveLength(2);
        });

        it('FPARSE-03 — broken JSON text keeps the complete items before the break', () => {
            const text = `[${JSON.stringify(finding())},{"relevantFile":"src/cart/totals.ts","existingCode":"say "hi""}]`;
            const r = run({ reasoning: 'r', suggestions: text });
            expect(r!.suggestions).toHaveLength(1);
        });

        it('FPARSE-05 — [] and {suggestions: []} are zero findings, not unusable', () => {
            expect(run([])).toEqual({ reasoning: '', suggestions: [] });
            expect(run({ reasoning: 'nothing', suggestions: [] })).toEqual({
                reasoning: 'nothing',
                suggestions: [],
            });
        });

        it('FPARSE-06 — a single finding sent as the whole payload is wrapped', () => {
            const r = run({ reasoning: 'one', ...finding() });
            expect(r!.reasoning).toBe('one');
            expect(r!.suggestions).toHaveLength(1);
            expect(r!.suggestions[0].relevantFile).toBe('src/cart/totals.ts');
        });

        it('FPARSE-07 — a {name, parameters} tool-call wrapper is unwrapped', () => {
            const r = run({
                name: 'submitResult',
                parameters: { reasoning: 'r', suggestions: [finding()] },
            });
            expect(r!.suggestions).toHaveLength(1);
        });

        it('FPARSE-08 — missing reasoning is empty, object reasoning is stringified', () => {
            expect(run({ suggestions: [finding()] })!.reasoning).toBe('');
            expect(
                run({ reasoning: { steps: 2 }, suggestions: [finding()] })!
                    .reasoning,
            ).toBe('{"steps":2}');
        });

        it('FPARSE-09 — reason is read as reasoning', () => {
            expect(
                run({ reason: 'checked totals', suggestions: [finding()] })!
                    .reasoning,
            ).toBe('checked totals');
        });

        it('FPARSE-31 — salvaged items that all fail are zero findings with each drop logged', () => {
            const r = run({
                reasoning: 'r',
                suggestions:
                    '[{"$text":"3"},{"relevantFile":"src/a.ts"},{"relevantFile":"src/b.ts","existingCode":"say "hi""}]',
            });
            expect(r).toEqual({ reasoning: 'r', suggestions: [] });
            expect(mockLogger.warn.mock.calls[0][0].metadata.dropped).toBe(2);
        });

        it('an object without suggestions, finding fields or wrapper is still unusable', () => {
            expect(
                run({ reasoning: 'Bug: total wrong in src/cart/totals.ts' }),
            ).toBeNull();
            expect(run({})).toBeNull();
        });
    });

    describe('logs (FPARSE-21, -22, -24)', () => {
        it('logs each drop once with reason, field, model, key names and shape', () => {
            run(
                {
                    reasoning: 'r',
                    suggestions: [
                        finding(),
                        {
                            relevantFile: 'src/cart/totals.ts',
                            oneSentenceSummary: 'double discount',
                            couponId: 'c-1',
                        },
                    ],
                },
                { organizationId: 'org-1', modelId: 'vendor:model-x' },
            );
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            const { metadata } = mockLogger.warn.mock.calls[0][0];
            expect(metadata).toMatchObject({
                kept: 1,
                dropped: 1,
                organizationId: 'org-1',
                modelId: 'vendor:model-x',
            });
            expect(metadata.drops).toEqual([
                {
                    // The summary stands in for the content, and a finding
                    // with neither code nor lines has nothing to anchor on.
                    reason: 'missing-location',
                    field: 'relevantLinesStart',
                    type: 'object',
                    length: expect.any(Number),
                    keys: ['relevantFile', 'oneSentenceSummary'],
                    unknownKeys: 1,
                    hasSummary: true,
                },
            ]);
        });

        it('logs the recovery reason when an off-shape payload was read whole', () => {
            run(
                { reasoning: 'r', suggestions: JSON.stringify([finding()]) },
                { modelId: 'vendor:model-x' },
            );
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            const [{ message, metadata }] = mockLogger.warn.mock.calls[0];
            expect(message).toContain(
                'recovered an off-shape findings payload',
            );
            expect(metadata.recoveries).toEqual(['parsed-field-string']);
            expect(metadata.modelId).toBe('vendor:model-x');
        });

        it('logs model-chosen key names only when they cannot carry content', () => {
            run({ 'reasoning': 'r', 'src/secret/path.ts': 'x', 'note': 'y' });
            const { rawKeys } = mockLogger.warn.mock.calls[0][0].metadata;
            expect(rawKeys).toEqual(['reasoning', '<other>', 'note']);
        });

        it('logs nothing for a canonical payload', () => {
            run({ reasoning: 'r', suggestions: [finding()] });
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        it('never logs item values', () => {
            run({
                reasoning: 'secret reasoning',
                suggestions: [
                    {
                        relevantFile: 'src/secret/path.ts',
                        existingCode: 'SECRET_CODE',
                    },
                    'SECRET_STRING_ITEM',
                    { $text: 'SECRET_TEXT_NODE' },
                ],
            });
            const logged = JSON.stringify(mockLogger.warn.mock.calls);
            for (const v of [
                'secret reasoning',
                'src/secret/path.ts',
                'SECRET_CODE',
                'SECRET_STRING_ITEM',
                'SECRET_TEXT_NODE',
            ]) {
                expect(logged).not.toContain(v);
            }
        });
    });
});
