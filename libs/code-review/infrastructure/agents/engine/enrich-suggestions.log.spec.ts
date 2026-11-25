const mockWarn = jest.fn();
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: (...args: unknown[]) => mockWarn(...args),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

import { enrichSuggestions } from './enrich-suggestions';

describe('enrichSuggestions — failure log', () => {
    it('logs each failed call with the org, team and PR, and keeps the suggestion', async () => {
        const file = { filename: 'src/a.ts', fileContent: 'line 1\nline 2\n', patch: '' };
        const { suggestions, counts } = await enrichSuggestions(
            [{ label: 'bug', relevantFile: 'src/a.ts', relevantLinesStart: 1, relevantLinesEnd: 1, suggestionContent: 'c' }],
            [file],
            {
                shouldEnrich: () => true,
                enrich: jest.fn().mockRejectedValue(new Error('429')) as any,
                organizationId: 'org-1',
                usageAttrs: { teamId: 'team-1', prNumber: 7 },
            },
        );
        expect(suggestions).toHaveLength(1);
        expect(counts.failed).toBe(1);
        expect(mockWarn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('429'),
                metadata: { organizationId: 'org-1', teamId: 'team-1', prNumber: 7 },
            }),
        );
    });
});
