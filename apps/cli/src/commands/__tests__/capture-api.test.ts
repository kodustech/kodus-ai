import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../../services/git.service.js', () => ({
    gitService: {
        isGitRepository: vi.fn().mockResolvedValue(true),
        getGitRoot: vi.fn().mockResolvedValue('/fake/repo'),
        getHeadSha: vi.fn().mockResolvedValue('abc1234'),
        getCurrentBranch: vi.fn().mockResolvedValue('feat/test'),
        extractOrgRepo: vi
            .fn()
            .mockResolvedValue({ org: 'kodustech', repo: 'cli' }),
    },
}));

vi.mock('../../services/transcript-parser.service.js', () => ({
    transcriptParserService: {
        parse: vi.fn().mockReturnValue({
            modifiedFiles: ['src/auth/jwt.ts'],
            toolUses: [{ tool: 'Write', filePath: 'src/auth/jwt.ts' }],
        }),
    },
}));

vi.mock('../../services/auth.service.js', () => ({
    authService: {
        isAuthenticated: vi.fn().mockResolvedValue(false),
        getValidToken: vi.fn().mockResolvedValue('fake-token'),
    },
}));

vi.mock('../../services/api/index.js', () => ({
    api: {
        memory: {
            submitCapture: vi
                .fn()
                .mockResolvedValue({ id: 'cap-123', accepted: true }),
        },
    },
}));

vi.mock('../../utils/stream-input.js', () => ({
    readStreamPayload: vi.fn().mockResolvedValue('{"stdin":true}'),
}));

import { captureAction } from '../memory/capture.js';
import { authService } from '../../services/auth.service.js';
import { api } from '../../services/api/index.js';
import { readStreamPayload } from '../../utils/stream-input.js';

beforeEach(() => {
    vi.clearAllMocks();
    // Default: stdin is a TTY so no stdin reading
    Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('capture API submission', () => {
    it('submits to API on stop event when authenticated', async () => {
        vi.mocked(authService.isAuthenticated).mockResolvedValue(true);

        await captureAction(undefined, { agent: 'claude-code', event: 'stop' });

        // Allow fire-and-forget promise to settle
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(api.memory.submitCapture).toHaveBeenCalledTimes(1);
        const [payload, token] = vi.mocked(api.memory.submitCapture).mock
            .calls[0];
        expect(payload.branch).toBe('feat/test');
        expect(payload.sha).toBe('abc1234');
        expect(payload.orgRepo).toBe('kodustech/cli');
        expect(payload.agent).toBe('claude-code');
        expect(payload.event).toBe('stop');
        expect(payload.capturedAt).toBeTruthy();
        expect(token).toBe('fake-token');
    });

    it('does NOT submit on non-stop events', async () => {
        vi.mocked(authService.isAuthenticated).mockResolvedValue(true);

        await captureAction(undefined, {
            agent: 'claude-code',
            event: 'user-prompt-submit',
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(api.memory.submitCapture).not.toHaveBeenCalled();
    });

    it('does NOT submit when not authenticated', async () => {
        vi.mocked(authService.isAuthenticated).mockResolvedValue(false);

        await captureAction(undefined, { agent: 'claude-code', event: 'stop' });

        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(api.memory.submitCapture).not.toHaveBeenCalled();
    });

    it('does not read stdin when running in a tty', async () => {
        vi.mocked(authService.isAuthenticated).mockResolvedValue(true);

        await captureAction(undefined, { agent: 'claude-code', event: 'stop' });

        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(readStreamPayload).not.toHaveBeenCalled();
        expect(api.memory.submitCapture).toHaveBeenCalledTimes(1);
    });

    it('does NOT throw if API call fails (fail-open)', async () => {
        vi.mocked(authService.isAuthenticated).mockResolvedValue(true);
        vi.mocked(api.memory.submitCapture).mockRejectedValue(
            new Error('network error'),
        );

        // Should not throw
        await captureAction(undefined, { agent: 'claude-code', event: 'stop' });

        // Allow fire-and-forget promise to settle
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(api.memory.submitCapture).toHaveBeenCalledTimes(1);
    });
});
