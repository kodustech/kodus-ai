const mockWarn = jest.fn();
const mockRead = jest.fn();
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: (...args: unknown[]) => mockWarn(...args),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));
jest.mock('@libs/common/utils/validateCodeReviewConfigFile', () => ({
    getDefaultKodusConfigFile: () => mockRead(),
}));

import { hasCustomSeverityFlags } from './severity-prompt';

describe('severity-prompt — shipped defaults', () => {
    it('logs a failed read with the org and reads the file again on the next call', () => {
        mockRead.mockImplementationOnce(() => {
            throw new Error('ENOENT');
        });
        const flags = { critical: 'Team criteria.' };

        expect(hasCustomSeverityFlags(flags, 'org-1')).toBe(true);
        expect(mockWarn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('ENOENT'),
                metadata: { organizationId: 'org-1' },
            }),
        );

        mockRead.mockReturnValue({
            v2PromptOverrides: { severity: { flags: { critical: 'Team criteria.' } } },
        });
        expect(hasCustomSeverityFlags(flags, 'org-1')).toBe(false);
        expect(mockRead).toHaveBeenCalledTimes(2);
    });
});
