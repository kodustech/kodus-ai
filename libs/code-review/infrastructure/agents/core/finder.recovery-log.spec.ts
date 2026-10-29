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

describe('recoverFindingsFromProse — failure log', () => {
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
});
