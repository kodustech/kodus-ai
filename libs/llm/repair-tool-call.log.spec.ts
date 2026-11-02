const mockLog = jest.fn();
const mockWarn = jest.fn();
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: (...args: unknown[]) => mockLog(...args),
        warn: (...args: unknown[]) => mockWarn(...args),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));
jest.mock('ai', () => {
    const actual = jest.requireActual('ai');
    return { ...actual, generateText: jest.fn() };
});

import { generateText, TypeValidationError } from 'ai';
import { repairInvalidToolInput } from './repair-tool-call';

const ids = { organizationId: 'org-1', teamId: 'team-1', prNumber: 7 };

describe('repairInvalidToolInput — log context', () => {
    it("puts the review's ids on the invoked and discarded logs", async () => {
        (generateText as jest.Mock).mockRejectedValueOnce(new Error('boom'));
        const out = await repairInvalidToolInput({
            model: {} as any,
            toolCall: { toolName: 'read_file', input: { pat: 'x' } },
            inputSchema: async () => ({
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
                additionalProperties: false,
            }),
            error: new TypeValidationError({ value: {}, cause: new Error('bad') }),
            logContext: ids,
        });
        expect(out).toBeNull();
        expect(mockLog).toHaveBeenCalledWith(
            expect.objectContaining({ metadata: expect.objectContaining(ids) }),
        );
        expect(mockWarn).toHaveBeenCalledWith(
            expect.objectContaining({ metadata: expect.objectContaining(ids) }),
        );
    });
});
