import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies that handleHook uses
vi.mock('../../services/git.service.js', () => ({
    gitService: {
        isGitRepository: vi.fn().mockResolvedValue(true),
        getGitRoot: vi.fn().mockResolvedValue('/tmp/repo'),
        getCurrentBranch: vi.fn().mockResolvedValue('main'),
        getHeadSha: vi.fn().mockResolvedValue('abc123'),
        getRemoteUrl: vi.fn().mockResolvedValue('git@github.com:org/repo.git'),
    },
}));

vi.mock('../../services/hook-logger.service.js', () => ({
    hookLogger: {
        init: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
    },
}));

const { dispatchMock } = vi.hoisted(() => ({
    dispatchMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/lifecycle.service.js', () => ({
    lifecycleService: {
        dispatch: dispatchMock,
    },
}));

import { cursorHookAction } from '../memory/session-hooks/cursor.js';
import { claudeCodeHookAction } from '../memory/session-hooks/claude-code.js';

describe('cursorHookAction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('silently ignores unknown hook names', async () => {
        await cursorHookAction('unknown-event');
        expect(dispatchMock).not.toHaveBeenCalled();
    });

    it('rejects empty string as hook name', async () => {
        await cursorHookAction('');
        expect(dispatchMock).not.toHaveBeenCalled();
    });

    it('rejects hooks not in the valid set', async () => {
        await cursorHookAction('pre-push');
        expect(dispatchMock).not.toHaveBeenCalled();
    });
});

describe('claudeCodeHookAction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('silently ignores unknown hook names', async () => {
        await claudeCodeHookAction('totally-invalid');
        expect(dispatchMock).not.toHaveBeenCalled();
    });

    it('rejects empty string as hook name', async () => {
        await claudeCodeHookAction('');
        expect(dispatchMock).not.toHaveBeenCalled();
    });

    it('rejects hooks not in the valid set', async () => {
        await claudeCodeHookAction('pre-push');
        expect(dispatchMock).not.toHaveBeenCalled();
    });
});
