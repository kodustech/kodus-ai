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
    extractFindings,
    extractFindingsWithRecovery,
    submitResultTool,
} from '@libs/code-review/infrastructure/agents/core/finder.agent';

// #2112 — the finder side of the findings parse. Invented shop domain.
const loggerFor = (name: string) =>
    (createLogger as jest.Mock).mock.results[
        (createLogger as jest.Mock).mock.calls.findIndex(([n]) => n === name)
    ].value;

const state = (payload: unknown): any => ({
    runId: 'r',
    agentId: 'finder',
    status: 'ok',
    steps: [],
    artifacts: [{ type: 'submitResult', payload }],
    usage: {},
    trace: [],
});

const finding = {
    relevantFile: 'src/cart/totals.ts',
    suggestionContent: 'Discount is applied twice when the coupon repeats',
    existingCode: 'total -= discount',
    improvedCode: 'total -= once(discount)',
};

const brokenText =
    '[{"relevantFile":"src/cart/totals.ts","existingCode":"say "hi""}]';

describe('finder findings parse (#2112)', () => {
    it('FPARSE-20 — one failure log per unusable artifact', () => {
        const warn = loggerFor('FindingsSchema').warn as jest.Mock;
        warn.mockClear();
        const s = state({ reasoning: 'r', suggestions: 'not json' });
        extractFindings(s);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(s.__findingsOutcome).toBe('artifact-unusable');
    });

    it('FPARSE-04 — unparseable findings text is appended to the reasoning the recoverer gets', async () => {
        const recover = jest.fn().mockResolvedValue([finding]);
        const out = await extractFindingsWithRecovery(
            state({
                reasoning: 'Checked the cart totals.',
                suggestions: brokenText,
            }),
            recover,
        );
        expect(recover).toHaveBeenCalledWith(
            `Checked the cart totals.\n\n${brokenText}`,
        );
        expect(out.suggestions).toEqual([finding]);
    });

    it('FPARSE-04 — a whole payload sent as unparseable text goes to the recoverer', async () => {
        const recover = jest.fn().mockResolvedValue([]);
        const text =
            '{"reasoning":"x","suggestions":[{"existingCode":"say "hi""}]}';
        await extractFindingsWithRecovery(state(text), recover);
        expect(recover).toHaveBeenCalledWith(text);
    });

    it('FPARSE-04 — unparseable text under an alias or a tool-call wrapper reaches the recoverer too', async () => {
        for (const payload of [
            { reasoning: 'r', findings: brokenText },
            { name: 'submitResult', parameters: { suggestions: brokenText } },
        ]) {
            const recover = jest.fn().mockResolvedValue([]);
            await extractFindingsWithRecovery(state(payload), recover);
            expect(recover.mock.calls[0][0]).toContain(brokenText);
        }
    });

    it('FPARSE-23 — logs a recovery that returned nothing for an unusable result', async () => {
        const log = loggerFor('finder').log as jest.Mock;
        log.mockClear();
        await extractFindingsWithRecovery(
            state({ reasoning: '', suggestions: 'not json' }),
            jest.fn().mockResolvedValue([]),
            { modelId: 'vendor:model-x' },
        );
        const call = log.mock.calls.find(([e]) =>
            String(e.message).includes('prose recovery returned'),
        );
        expect(call?.[0].metadata).toMatchObject({
            recovered: 0,
            outcome: 'artifact-unusable',
        });
    });

    it('FPARSE-23 — does not log for a structured result with nothing recovered', async () => {
        const log = loggerFor('finder').log as jest.Mock;
        log.mockClear();
        await extractFindingsWithRecovery(
            state({
                reasoning: 'Looked at the cart, all good.',
                suggestions: [],
            }),
            jest.fn().mockResolvedValue([]),
        );
        expect(
            log.mock.calls.some(([e]) =>
                String(e.message).includes('prose recovery returned'),
            ),
        ).toBe(false);
    });

    it('FPARSE-18 — the submitResult tool schema keeps its required fields', () => {
        const schema = submitResultTool.inputSchema as any;
        expect(schema.required).toEqual(['reasoning', 'suggestions']);
        expect(schema.properties.suggestions.items.required).toEqual([
            'relevantFile',
            'suggestionContent',
            'existingCode',
            'improvedCode',
            'oneSentenceSummary',
        ]);
    });

    it('FPARSE-23 — logs how many findings the prose recovery returned, with the model', async () => {
        const log = loggerFor('finder').log as jest.Mock;
        log.mockClear();
        await extractFindingsWithRecovery(
            state({ reasoning: 'Bug in src/cart/totals.ts:12 — fix it' }),
            jest.fn().mockResolvedValue([finding, finding]),
            { organizationId: 'org-1', modelId: 'vendor:model-x' },
        );
        const call = log.mock.calls.find(([e]) =>
            String(e.message).includes('prose recovery returned'),
        );
        expect(call?.[0].metadata).toEqual({
            recovered: 2,
            outcome: 'artifact-unusable',
            organizationId: 'org-1',
            modelId: 'vendor:model-x',
        });
    });

    it('passes modelId to the drop log', () => {
        const warn = loggerFor('FindingsSchema').warn as jest.Mock;
        warn.mockClear();
        extractFindings(
            state({ reasoning: 'r', suggestions: [finding, { $text: '3' }] }),
            {
                organizationId: 'org-1',
                modelId: 'vendor:model-x',
            },
        );
        expect(warn.mock.calls[0][0].metadata.modelId).toBe('vendor:model-x');
    });
});
