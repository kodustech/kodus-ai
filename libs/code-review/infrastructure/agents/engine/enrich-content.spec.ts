import type { NormalizedModel } from '@libs/llm/byok-config';
import { LLM } from '@libs/llm/llm';
import { estimateTextTokens } from '@libs/llm/token-estimate';

import {
    buildEnrichmentPrompt,
    ENRICH_MAX_LINE_CHARS,
    enrichOneShot,
    fitEnrichmentInput,
    type EnrichmentInput,
} from './enrich-content';

jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));
const mockWarn = jest.fn();
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        warn: (...args: unknown[]) => mockWarn(...args),
        log: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

const run = LLM.run as jest.Mock;

/** The 24k slot of the #2233 QA, with a declared answer. */
const slot = {
    provider: 'openai_compatible',
    model: 'qa/small-window',
    maxInputTokens: 24_000,
    maxOutputTokens: 2_000,
} as NormalizedModel;

const sent = () => {
    const { system, user } = run.mock.calls[0][0];
    return (
        estimateTextTokens(system, { worstCase: true }) +
        estimateTextTokens(user, { worstCase: true })
    );
};

const input = (over: Partial<EnrichmentInput> = {}): EnrichmentInput => ({
    finding: {
        label: 'bug',
        relevantFile: 'src/enrollment/discount-lookup.ts',
        relevantLinesStart: 11,
        relevantLinesEnd: 12,
        suggestionContent: 'The discount is applied twice.',
    },
    existingCode: 'return fee - fee * 0.1;\nreturn fee;',
    language: 'typescript',
    fileWindow: '10 | if (siblings > 0) {\n11 | return fee - fee * 0.1;',
    filePatch: '@@ -10,2 +10,2 @@\n-return fee;\n+return fee - fee * 0.1;',
    ...over,
});

describe('enrichOneShot window (#2233 QA)', () => {
    beforeEach(() => {
        run.mockReset();
        run.mockResolvedValue({
            title: 'Discount applied twice',
            fixStatus: 'no-code-fix',
            improvedCode: '',
        });
    });

    // QA: a flagged line in a file with an 80k-character line sent one
    // 92,403-token request on a 24k slot.
    it('sends no request larger than the window when the file has an 80k-character line', async () => {
        const long = `13 | const TABLE = "${'9'.repeat(80_000)}";`;
        await enrichOneShot(
            input({
                fileWindow: `${input().fileWindow}\n${long}`,
                filePatch: `${input().filePatch}\n+${long}`,
            }),
            { byokConfig: slot, organizationId: 'org' },
        );
        expect(run).toHaveBeenCalledTimes(1);
        expect(sent()).toBeLessThanOrEqual(24_000 - 2_000);
        // The cited code still goes whole: the fix replaces exactly it.
        expect(run.mock.calls[0][0].user).toContain(input().existingCode);
    });

    it('sends no call when the cited code alone is larger than the window', async () => {
        const result = await enrichOneShot(
            input({ existingCode: `const T = "${'9'.repeat(80_000)}";` }),
            { byokConfig: slot, organizationId: 'org' },
        );
        expect(run).not.toHaveBeenCalled();
        expect(result).toBeNull();
    });

    it('sends a small input as it is', async () => {
        await enrichOneShot(input(), {
            byokConfig: slot,
            organizationId: 'org',
        });
        const { user } = run.mock.calls[0][0];
        expect(user).toContain(input().fileWindow);
        expect(user).toContain(input().filePatch);
    });
});

describe('fitEnrichmentInput', () => {
    const tokensOf = (i: EnrichmentInput) => {
        // Counted the way the fit counts: the prompt it would send.
        const { buildEnrichmentPrompt } =
            jest.requireActual('./enrich-content');
        const { system, user } = buildEnrichmentPrompt(i);
        return (
            estimateTextTokens(system, { worstCase: true }) +
            estimateTextTokens(user, { worstCase: true })
        );
    };
    const long = 'x'.repeat(ENRICH_MAX_LINE_CHARS + 500);
    const wide = input({
        fileWindow: `short\n${long}`,
        filePatch: `+short\n+${long}`,
    });

    it('keeps the input whole when it fits', () => {
        expect(fitEnrichmentInput(wide, tokensOf(wide))).toEqual(wide);
    });

    it('cuts only the long lines first, and says how long they were', () => {
        const fitted = fitEnrichmentInput(wide, tokensOf(wide) - 1)!;
        expect(fitted.fileWindow).toContain('short\n');
        expect(fitted.fileWindow).toContain(
            `(line cut: ${long.length} characters)`,
        );
        expect(fitted.fileWindow).not.toContain(long);
        expect(fitted.filePatch).toContain('+short\n');
        expect(fitted.existingCode).toBe(wide.existingCode);
    });

    it('leaves the diff out before the file window, and both before the cited code', () => {
        const cutLines = fitEnrichmentInput(wide, tokensOf(wide) - 1)!;
        const noDiff = fitEnrichmentInput(wide, tokensOf(cutLines) - 1)!;
        expect(noDiff.filePatch).toMatch(/left out/);
        expect(noDiff.fileWindow).toBe(cutLines.fileWindow);
        const neither = fitEnrichmentInput(wide, tokensOf(noDiff) - 1)!;
        expect(neither.fileWindow).toMatch(/left out/);
        expect(neither.existingCode).toBe(wide.existingCode);
        expect(fitEnrichmentInput(wide, tokensOf(neither) - 1)).toBeUndefined();
    });

    it('never ends a cut line on half a surrogate pair', () => {
        const emoji = `${'a'.repeat(ENRICH_MAX_LINE_CHARS - 1)}😀${'b'.repeat(100)}`;
        const fitted = fitEnrichmentInput(
            input({ fileWindow: emoji }),
            tokensOf(input({ fileWindow: emoji })) - 1,
        )!;
        expect(fitted.fileWindow).not.toMatch(
            /[\ud800-\udbff](?![\udc00-\udfff])/,
        );
    });
});

describe('enrichOneShot room', () => {
    const promptTokens = (i: EnrichmentInput) => {
        const { system, user } = buildEnrichmentPrompt(i);
        return (
            estimateTextTokens(system, { worstCase: true }) +
            estimateTextTokens(user, { worstCase: true })
        );
    };
    /** An input whose prompt is just over `target` tokens, made of short
     *  lines in the file window (nothing to cut but the window itself). */
    const sized = (target: number) => {
        const lines: string[] = [];
        let built = input();
        for (let n = 0; promptTokens(built) < target; n += 50) {
            for (let k = 0; k < 50; k++) {
                lines.push(`${n + k} | const value${n + k} = compute(x);`);
            }
            built = input({ fileWindow: lines.join('\n') });
        }
        while (
            lines.length &&
            promptTokens(
                input({ fileWindow: lines.slice(0, -1).join('\n') }),
            ) >= target
        ) {
            lines.pop();
        }
        return input({ fileWindow: lines.join('\n') });
    };
    const sentWhole = async (i: EnrichmentInput, s: NormalizedModel) => {
        run.mockClear();
        await enrichOneShot(i, { byokConfig: s, organizationId: 'org' });
        return !/left out/.test(run.mock.calls[0]?.[0].user ?? 'left out');
    };

    beforeEach(() => {
        run.mockReset();
        run.mockResolvedValue({
            title: 't',
            fixStatus: 'no-code-fix',
            improvedCode: '',
        });
    });

    // 24,000 - 2,000 declared, of which 90%: 19,800.
    it('fits the window less the answer the slot declares, with a margin', async () => {
        expect(await sentWhole(sized(19_700), slot)).toBe(true);
        expect(await sentWhole(sized(19_900), slot)).toBe(false);
    });

    // No answer declared: a quarter of 24,000 kept for it, 90% of the rest.
    it('keeps a quarter of the window for an answer the slot does not declare', async () => {
        const undeclared = {
            ...slot,
            maxOutputTokens: undefined,
        } as NormalizedModel;
        expect(await sentWhole(sized(16_100), undeclared)).toBe(true);
        expect(await sentWhole(sized(16_300), undeclared)).toBe(false);
    });

    it('says which finding it could not enrich, and for whom', async () => {
        mockWarn.mockClear();
        await enrichOneShot(input({ existingCode: 'x'.repeat(80_000) }), {
            byokConfig: slot,
            organizationId: 'org',
            attrs: { teamId: 't1', prNumber: 7 },
        });
        expect(mockWarn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining(
                    'src/enrollment/discount-lookup.ts:11 not enriched',
                ),
                context: 'EnrichContent',
                metadata: { organizationId: 'org', teamId: 't1', prNumber: 7 },
            }),
        );
        mockWarn.mockClear();
        await enrichOneShot(
            input({ existingCode: 'x'.repeat(80_000), finding: {} }),
            { byokConfig: slot, organizationId: 'org' },
        );
        expect(mockWarn.mock.calls[0][0].message).toContain(
            '[ENRICH] ?:? not enriched',
        );
    });
});

describe('fitEnrichmentInput line cuts', () => {
    const cutOnce = (fileWindow: string) => {
        const i = input({ fileWindow });
        const { system, user } = buildEnrichmentPrompt(i);
        const all =
            estimateTextTokens(system, { worstCase: true }) +
            estimateTextTokens(user, { worstCase: true });
        return fitEnrichmentInput(i, all - 1)!.fileWindow;
    };

    it(`keeps a line of exactly ${ENRICH_MAX_LINE_CHARS} characters`, () => {
        const line = 'x'.repeat(ENRICH_MAX_LINE_CHARS);
        expect(cutOnce(`${line}\nshort`)).toBe(`${line}\nshort`);
    });

    it('cuts a long line at the limit, a pair earlier than its middle', () => {
        const atLimit = `${'a'.repeat(ENRICH_MAX_LINE_CHARS - 1)}😀${'b'.repeat(100)}`;
        expect(cutOnce(atLimit)).toBe(
            `${'a'.repeat(ENRICH_MAX_LINE_CHARS - 1)} … (line cut: ${atLimit.length} characters)`,
        );
        const pairFirst = `😀${'a'.repeat(ENRICH_MAX_LINE_CHARS + 100)}`;
        expect(cutOnce(pairFirst)).toBe(
            `😀${'a'.repeat(ENRICH_MAX_LINE_CHARS - 2)} … (line cut: ${pairFirst.length} characters)`,
        );
    });
});
