import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendEventMock } = vi.hoisted(() => ({
    sendEventMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../git.service.js', () => ({
    gitService: {
        isGitRepository: vi.fn().mockResolvedValue(true),
        getCurrentBranch: vi.fn().mockResolvedValue('main'),
        getHeadSha: vi.fn().mockResolvedValue('abc123'),
        getRemoteUrl: vi.fn().mockResolvedValue('git@github.com:org/repo.git'),
        getGitRoot: vi.fn().mockResolvedValue('/tmp/repo'),
    },
}));

vi.mock('../hook-logger.service.js', () => ({
    hookLogger: {
        init: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('../transcript.service.js', () => ({
    transcriptService: {
        waitForFlush: vi.fn().mockResolvedValue(false),
        parse: vi.fn().mockResolvedValue({
            toolCalls: [],
            filesRead: [],
            commands: [],
            assistantMessages: [],
            tokenUsage: {
                inputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                outputTokens: 0,
                apiCallCount: 0,
            },
            modifiedFiles: [],
        }),
    },
}));

vi.mock('../session-local.service.js', () => ({
    saveLocal: vi.fn().mockResolvedValue(undefined),
    loadLocal: vi.fn().mockResolvedValue(null),
    removeLocal: vi.fn().mockResolvedValue(undefined),
    listStaleSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock('../api/index.js', () => ({
    api: {
        sessions: {
            sendEvent: sendEventMock,
        },
    },
}));

import { lifecycleService } from '../lifecycle.service.js';
import type { LifecycleEvent } from '../../types/session.js';

function makeEvent(overrides: Partial<LifecycleEvent>): LifecycleEvent {
    return {
        type: 'SessionStart',
        sessionId: 'sess-1',
        sessionRef: '/tmp/transcript.jsonl',
        timestamp: new Date().toISOString(),
        ...overrides,
    };
}

describe('LifecycleService.dispatch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('sends session_start event with git context', async () => {
        await lifecycleService.dispatch(
            '/tmp/repo',
            'claude-code',
            makeEvent({
                type: 'SessionStart',
            }),
        );

        expect(sendEventMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'session_start',
                sessionId: 'sess-1',
                branch: 'main',
                agentType: 'claude-code',
                gitRemote: 'git@github.com:org/repo.git',
                baseCommit: 'abc123',
            }),
            '/tmp/repo',
        );
    });

    it('sends turn_start event with prompt', async () => {
        await lifecycleService.dispatch(
            '/tmp/repo',
            'claude-code',
            makeEvent({
                type: 'TurnStart',
                prompt: 'Fix the auth bug',
            }),
        );

        expect(sendEventMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'turn_start',
                sessionId: 'sess-1',
                prompt: 'Fix the auth bug',
            }),
            '/tmp/repo',
        );
    });

    it('sends turn_end event', async () => {
        await lifecycleService.dispatch(
            '/tmp/repo',
            'claude-code',
            makeEvent({
                type: 'TurnEnd',
            }),
        );

        // loadLocal returns null, so a synthetic turn_start is sent first
        expect(sendEventMock).toHaveBeenCalledTimes(2);
        expect(sendEventMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'turn_start',
                sessionId: 'sess-1',
                prompt: '',
            }),
            '/tmp/repo',
        );
        expect(sendEventMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'turn_end',
                sessionId: 'sess-1',
            }),
            '/tmp/repo',
        );
    });

    it('emits synthetic turn_start when turn_end fires without prior turn_start', async () => {
        const { hookLogger } = await import('../hook-logger.service.js');

        await lifecycleService.dispatch(
            '/tmp/repo',
            'claude-code',
            makeEvent({
                type: 'TurnEnd',
            }),
        );

        // Should warn about missing turn_start
        expect(hookLogger.warn).toHaveBeenCalledWith(
            'turn-end-without-turn-start',
            'lifecycle',
            expect.objectContaining({
                agent: 'claude-code',
                model_session_id: 'sess-1',
                synthetic_turn_id: expect.any(String),
            }),
        );

        // Should send synthetic turn_start + turn_end
        const calls = sendEventMock.mock.calls.map(
            (c: unknown[]) => (c[0] as { type: string }).type,
        );
        expect(calls).toEqual(['turn_start', 'turn_end']);

        // Both should share the same turnId
        const synthStart = sendEventMock.mock.calls[0][0];
        const turnEnd = sendEventMock.mock.calls[1][0];
        expect(synthStart.turnId).toBe(turnEnd.turnId);
        expect(synthStart.turnId).toBeTruthy();
    });

    it('sends session_end event and cleans up local state', async () => {
        const { removeLocal } = await import('../session-local.service.js');

        await lifecycleService.dispatch(
            '/tmp/repo',
            'claude-code',
            makeEvent({
                type: 'SessionEnd',
            }),
        );

        expect(sendEventMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'session_end',
                sessionId: 'sess-1',
            }),
            '/tmp/repo',
        );
        expect(removeLocal).toHaveBeenCalledWith('/tmp/repo', 'sess-1');
    });

    it('sends subagent_start event', async () => {
        await lifecycleService.dispatch(
            '/tmp/repo',
            'claude-code',
            makeEvent({
                type: 'SubagentStart',
                toolUseId: 'tool-1',
                subagentType: 'Explore',
                taskDescription: 'Find all controllers',
            }),
        );

        expect(sendEventMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'subagent_start',
                sessionId: 'sess-1',
                toolUseId: 'tool-1',
                subagentType: 'Explore',
                taskDescription: 'Find all controllers',
            }),
            '/tmp/repo',
        );
    });

    it('sends subagent_end event', async () => {
        await lifecycleService.dispatch(
            '/tmp/repo',
            'claude-code',
            makeEvent({
                type: 'SubagentEnd',
                toolUseId: 'tool-1',
            }),
        );

        expect(sendEventMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'subagent_end',
                toolUseId: 'tool-1',
            }),
            '/tmp/repo',
        );
    });

    it('skips subagent_start when toolUseId is missing', async () => {
        await lifecycleService.dispatch(
            '/tmp/repo',
            'claude-code',
            makeEvent({
                type: 'SubagentStart',
                toolUseId: undefined,
            }),
        );

        expect(sendEventMock).not.toHaveBeenCalled();
    });

    it('skips subagent_end when toolUseId is missing', async () => {
        await lifecycleService.dispatch(
            '/tmp/repo',
            'claude-code',
            makeEvent({
                type: 'SubagentEnd',
                toolUseId: undefined,
            }),
        );

        expect(sendEventMock).not.toHaveBeenCalled();
    });

    it('skips duplicate turn_end when turn is already completed', async () => {
        const { loadLocal } = await import('../session-local.service.js');
        const { hookLogger } = await import('../hook-logger.service.js');

        // Simulate a turn that was already completed
        vi.mocked(loadLocal).mockResolvedValueOnce({
            turnId: '12345',
            transcriptPath: '/tmp/transcript.jsonl',
            transcriptOffset: 0,
            turnCompleted: true,
        });

        await lifecycleService.dispatch(
            '/tmp/repo',
            'claude-code',
            makeEvent({ type: 'TurnEnd' }),
        );

        // Should log dedup skip
        expect(hookLogger.info).toHaveBeenCalledWith(
            'turn-end-dedup-skipped',
            'lifecycle',
            expect.objectContaining({
                turn_id: '12345',
            }),
        );

        // Should NOT send any event
        expect(sendEventMock).not.toHaveBeenCalled();
    });

    it('saves turnCompleted before sending turn_end', async () => {
        const { loadLocal, saveLocal } = await import(
            '../session-local.service.js'
        );

        vi.mocked(loadLocal).mockResolvedValueOnce({
            turnId: '12345',
            transcriptPath: '',
            transcriptOffset: 0,
        });

        await lifecycleService.dispatch(
            '/tmp/repo',
            'claude-code',
            makeEvent({ type: 'TurnEnd' }),
        );

        expect(sendEventMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'turn_end', turnId: '12345' }),
            '/tmp/repo',
        );
        // turnCompleted saved via saveLocal (not markTurnCompleted)
        expect(saveLocal).toHaveBeenCalledWith('/tmp/repo', 'sess-1', expect.objectContaining({
            turnId: '12345',
            turnCompleted: true,
        }));
    });

    it('sends synthetic session_end for stale sessions on session_start', async () => {
        const { listStaleSessions, removeLocal } = await import(
            '../session-local.service.js'
        );
        const { hookLogger } = await import('../hook-logger.service.js');

        vi.mocked(listStaleSessions).mockResolvedValueOnce([
            { sessionId: 'stale-sess-1', ageMs: 60 * 60 * 1000 },
            { sessionId: 'stale-sess-2', ageMs: 45 * 60 * 1000 },
        ]);

        await lifecycleService.dispatch(
            '/tmp/repo',
            'claude-code',
            makeEvent({ type: 'SessionStart' }),
        );

        // Should log cleanup for each stale session
        expect(hookLogger.info).toHaveBeenCalledWith(
            'stale-session-cleanup',
            'lifecycle',
            expect.objectContaining({ stale_session_id: 'stale-sess-1' }),
        );
        expect(hookLogger.info).toHaveBeenCalledWith(
            'stale-session-cleanup',
            'lifecycle',
            expect.objectContaining({ stale_session_id: 'stale-sess-2' }),
        );

        // Should send session_end for stale sessions + session_start for current
        expect(sendEventMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'session_end',
                sessionId: 'stale-sess-1',
            }),
            '/tmp/repo',
        );
        expect(sendEventMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'session_end',
                sessionId: 'stale-sess-2',
            }),
            '/tmp/repo',
        );
        expect(sendEventMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'session_start',
                sessionId: 'sess-1',
            }),
            '/tmp/repo',
        );

        // Should remove stale local state files
        expect(removeLocal).toHaveBeenCalledWith('/tmp/repo', 'stale-sess-1');
        expect(removeLocal).toHaveBeenCalledWith('/tmp/repo', 'stale-sess-2');
    });
});
