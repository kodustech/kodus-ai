const mockWarn = jest.fn();
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: (...args: unknown[]) => mockWarn(...args),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

import { LLM } from '@libs/llm/llm';
import { recoverFindingsFromProse } from './finder.agent';

const prose =
    'In src/orders.ts:42 the total is computed without the quantity, so ' +
    'every order with more than one item is undercharged. This is a bug: ' +
    'multiply the price by the quantity instead.';

describe('recoverFindingsFromProse', () => {
    afterEach(() => jest.restoreAllMocks());

    it('logs a failed recovery call with the org and team, and recovers nothing', async () => {
        jest.spyOn(LLM, 'run').mockRejectedValue(new Error('network down'));

        const out = await recoverFindingsFromProse(
            prose,
            undefined,
            'org-1',
            'code-review-generalist',
            undefined,
            undefined,
            'team-1',
        );

        expect(out).toEqual([]);
        expect(mockWarn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('network down'),
                metadata: expect.objectContaining({
                    organizationId: 'org-1',
                    teamId: 'team-1',
                    runName: 'code-review-generalist-recovery',
                }),
            }),
        );
    });

    it("asks a custom agent's recovery for the full finding, the finder's for the lean one", async () => {
        const spy = jest
            .spyOn(LLM, 'run')
            .mockResolvedValue({ suggestions: [] } as any);
        const fieldsOf = (call: number) =>
            Object.keys(
                (spy.mock.calls[call][0] as any).schema.shape.suggestions
                    .element.shape,
            );

        await recoverFindingsFromProse(prose, undefined, 'org-1');
        await recoverFindingsFromProse(
            prose,
            undefined,
            'org-1',
            undefined,
            [
                {
                    suggestionId: 'old',
                    suggestionContent: 'Earlier.',
                    label: 'bug',
                    outcome: 'pending',
                    decidedAt: '2026-10-01T10:00:00Z',
                },
            ],
            undefined,
            'team-1',
            true,
        );

        expect(fieldsOf(0)).not.toContain('severity');
        expect(fieldsOf(1)).toEqual(
            expect.arrayContaining([
                'existingCode',
                'improvedCode',
                'oneSentenceSummary',
                'severity',
                'revisesSuggestionId',
            ]),
        );
    });
});
