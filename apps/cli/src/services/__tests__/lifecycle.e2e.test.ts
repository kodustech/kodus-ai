import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { LifecycleEvent, TranscriptParseResult } from '../../types/session.js';
import type { SessionApiEvent } from '../../types/session-events.js';

// ---------------------------------------------------------------------------
// Captured events & logs
// ---------------------------------------------------------------------------
const sentEvents: SessionApiEvent[] = [];
const logEntries: Array<{ level: string; msg: string; data: Record<string, unknown> }> = [];

// ---------------------------------------------------------------------------
// Mocks — only external boundaries
// ---------------------------------------------------------------------------

vi.mock('../git.service.js', () => ({
    gitService: {
        isGitRepository: vi.fn().mockResolvedValue(true),
        getGitRoot: vi.fn().mockResolvedValue('/tmp/fake-repo'),
        getHeadSha: vi.fn().mockResolvedValue('abc123def456'),
        getCurrentBranch: vi.fn().mockResolvedValue('feat/my-feature'),
        getRemoteUrl: vi.fn().mockResolvedValue('git@github.com:org/repo.git'),
    },
}));

vi.mock('../hook-logger.service.js', () => ({
    hookLogger: {
        init: vi.fn().mockResolvedValue(undefined),
        info: vi.fn(async (msg: string, component: string, data: Record<string, unknown>) => {
            logEntries.push({ level: 'info', msg, data });
        }),
        warn: vi.fn(async (msg: string, component: string, data: Record<string, unknown>) => {
            logEntries.push({ level: 'warn', msg, data });
        }),
        error: vi.fn(async (msg: string, component: string, data: Record<string, unknown>) => {
            logEntries.push({ level: 'error', msg, data });
        }),
    },
}));

vi.mock('../api/index.js', () => ({
    api: {
        sessions: {
            sendEvent: vi.fn(async (event: SessionApiEvent) => {
                sentEvents.push(JSON.parse(JSON.stringify(event)));
            }),
        },
    },
}));

const mockParseResult: TranscriptParseResult = {
    prompts: ['refactor the auth module'],
    assistantMessages: ['I have refactored the auth module.'],
    modifiedFiles: ['src/auth.ts', 'src/config.ts'],
    tokenUsage: {
        inputTokens: 1200,
        outputTokens: 350,
        cacheCreationTokens: 100,
        cacheReadTokens: 50,
        apiCallCount: 3,
    },
    summary: 'Refactored auth module',
    subagentIds: [],
    entryCount: 8,
    toolCalls: [
        {
            toolName: 'Read',
            toolUseId: 'tu-read-1',
            timestamp: '2026-03-11T10:00:00Z',
            input: { file_path: 'src/auth.ts' },
            isMcp: false,
            fileAffected: 'src/auth.ts',
        },
        {
            toolName: 'Edit',
            toolUseId: 'tu-edit-1',
            timestamp: '2026-03-11T10:00:01Z',
            input: { file_path: 'src/auth.ts' },
            isMcp: false,
            fileAffected: 'src/auth.ts',
        },
        {
            toolName: 'Bash',
            toolUseId: 'tu-bash-1',
            timestamp: '2026-03-11T10:00:02Z',
            input: { command: 'npm test' },
            isMcp: false,
        },
    ],
    filesRead: ['src/auth.ts'],
    commands: ['npm test'],
};

vi.mock('../transcript.service.js', () => ({
    transcriptService: {
        waitForFlush: vi.fn().mockResolvedValue(true),
        parse: vi.fn().mockResolvedValue(mockParseResult),
    },
}));

// NOTE: session-local.service is NOT mocked — we use the REAL implementation
// with a temp directory to test actual file-based state management.

// ---------------------------------------------------------------------------
// Import the real lifecycle service (after mocks are set up)
// ---------------------------------------------------------------------------
const { lifecycleService } = await import('../lifecycle.service.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRepoRoot: string;

async function createTmpRepoRoot(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-e2e-'));
}

function eventsByType(type: string): SessionApiEvent[] {
    return sentEvents.filter((e) => e.type === type);
}

function lastEventOfType(type: string): SessionApiEvent | undefined {
    const events = eventsByType(type);
    return events[events.length - 1];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Lifecycle E2E — full session flow', () => {
    const sessionId = 'e2e-session-001';
    const transcriptPath = '/tmp/fake-transcript.jsonl';

    beforeEach(async () => {
        sentEvents.length = 0;
        logEntries.length = 0;
        vi.clearAllMocks();
        tmpRepoRoot = await createTmpRepoRoot();
    });

    afterEach(async () => {
        // Clean up temp dir
        await fs.rm(tmpRepoRoot, { recursive: true, force: true }).catch(() => {});
    });

    it('exercises a complete session lifecycle: start → turns → dedup → new turn → end', async () => {
        // ─── 1. Session Start ──────────────────────────────────────────
        await lifecycleService.dispatch(tmpRepoRoot, 'claude-code', {
            type: 'SessionStart',
            sessionId,
            sessionRef: transcriptPath,
            timestamp: new Date().toISOString(),
        });

        expect(eventsByType('session_start')).toHaveLength(1);
        const sessionStart = lastEventOfType('session_start')!;
        expect(sessionStart.sessionId).toBe(sessionId);
        if (sessionStart.type === 'session_start') {
            expect(sessionStart.branch).toBe('feat/my-feature');
            expect(sessionStart.baseCommit).toBe('abc123def456');
            expect(sessionStart.gitRemote).toBe('git@github.com:org/repo.git');
            expect(sessionStart.agentType).toBe('claude-code');
            expect(sessionStart.cliVersion).toBeTruthy();
        }

        // ─── 2. Turn Start ────────────────────────────────────────────
        await lifecycleService.dispatch(tmpRepoRoot, 'claude-code', {
            type: 'TurnStart',
            sessionId,
            sessionRef: transcriptPath,
            prompt: 'refactor the auth module',
            timestamp: new Date().toISOString(),
        });

        expect(eventsByType('turn_start')).toHaveLength(1);
        const turnStart = lastEventOfType('turn_start')!;
        expect(turnStart.type).toBe('turn_start');

        let firstTurnId = '';
        if (turnStart.type === 'turn_start') {
            expect(turnStart.prompt).toBe('refactor the auth module');
            expect(turnStart.commitBefore).toBe('abc123def456');
            expect(turnStart.turnId).toBeTruthy();
            firstTurnId = turnStart.turnId;
        }

        // Verify local state file was created on disk
        const sessionsDir = path.join(tmpRepoRoot, '.kody', 'sessions');
        const localFile = path.join(sessionsDir, `${sessionId}.json`);
        const localContent = JSON.parse(await fs.readFile(localFile, 'utf-8'));
        expect(localContent.turnId).toBe(firstTurnId);
        expect(localContent.transcriptPath).toBe(transcriptPath);
        expect(localContent.turnCompleted).toBeUndefined();

        // ─── 3. Turn End ──────────────────────────────────────────────
        await lifecycleService.dispatch(tmpRepoRoot, 'claude-code', {
            type: 'TurnEnd',
            sessionId,
            sessionRef: transcriptPath,
            timestamp: new Date().toISOString(),
        });

        expect(eventsByType('turn_end')).toHaveLength(1);
        const turnEnd = lastEventOfType('turn_end')!;
        if (turnEnd.type === 'turn_end') {
            // turnId must match the one from TurnStart
            expect(turnEnd.turnId).toBe(firstTurnId);
            expect(turnEnd.commitAfter).toBe('abc123def456');
            expect(turnEnd.response).toBe('I have refactored the auth module.');
            expect(turnEnd.toolCalls).toHaveLength(3);
            expect(turnEnd.toolCalls.map((tc) => tc.toolName)).toEqual([
                'Read',
                'Edit',
                'Bash',
            ]);
            expect(turnEnd.filesModified).toHaveLength(2);
            expect(turnEnd.filesModified.map((f) => f.path)).toContain('src/auth.ts');
            expect(turnEnd.filesModified.map((f) => f.path)).toContain('src/config.ts');
            expect(turnEnd.filesRead).toEqual(['src/auth.ts']);
            expect(turnEnd.commands).toEqual(['npm test']);
            expect(turnEnd.tokenUsage.inputTokens).toBe(1200);
            expect(turnEnd.tokenUsage.outputTokens).toBe(350);
        }

        // Verify local state marked as completed on disk
        const localAfterEnd = JSON.parse(await fs.readFile(localFile, 'utf-8'));
        expect(localAfterEnd.turnCompleted).toBe(true);

        // ─── 4. Duplicate Turn End (dedup) ────────────────────────────
        const eventsBeforeDedup = sentEvents.length;

        await lifecycleService.dispatch(tmpRepoRoot, 'claude-code', {
            type: 'TurnEnd',
            sessionId,
            sessionRef: transcriptPath,
            timestamp: new Date().toISOString(),
        });

        // No new event should be sent
        expect(sentEvents.length).toBe(eventsBeforeDedup);
        expect(eventsByType('turn_end')).toHaveLength(1);

        // Verify dedup was logged
        const dedupLog = logEntries.find((l) => l.msg === 'turn-end-dedup-skipped');
        expect(dedupLog).toBeDefined();
        expect(dedupLog!.data.turn_id).toBe(firstTurnId);

        // ─── 5. New Turn (second turn in same session) ────────────────
        await lifecycleService.dispatch(tmpRepoRoot, 'claude-code', {
            type: 'TurnStart',
            sessionId,
            sessionRef: transcriptPath,
            prompt: 'now add unit tests',
            timestamp: new Date().toISOString(),
        });

        expect(eventsByType('turn_start')).toHaveLength(2);
        const secondTurnStart = lastEventOfType('turn_start')!;
        let secondTurnId = '';
        if (secondTurnStart.type === 'turn_start') {
            secondTurnId = secondTurnStart.turnId;
            expect(secondTurnId).toBeTruthy();
            // Must be a DIFFERENT turnId from the first turn
            expect(secondTurnId).not.toBe(firstTurnId);
            expect(secondTurnStart.prompt).toBe('now add unit tests');
        }

        // Local state should have been overwritten (new turn, not completed)
        const localSecondTurn = JSON.parse(await fs.readFile(localFile, 'utf-8'));
        expect(localSecondTurn.turnId).toBe(secondTurnId);
        expect(localSecondTurn.turnCompleted).toBeUndefined();

        // ─── 6. Session End ──────────────────────────────────────────
        await lifecycleService.dispatch(tmpRepoRoot, 'claude-code', {
            type: 'SessionEnd',
            sessionId,
            sessionRef: transcriptPath,
            timestamp: new Date().toISOString(),
        });

        expect(eventsByType('session_end')).toHaveLength(1);
        const sessionEnd = lastEventOfType('session_end')!;
        expect(sessionEnd.sessionId).toBe(sessionId);
        expect(sessionEnd.branch).toBe('feat/my-feature');

        // Local state file should be cleaned up
        await expect(fs.access(localFile)).rejects.toThrow();

        // ─── Final tally ─────────────────────────────────────────────
        // session_start(1) + turn_start(2) + turn_end(1) + session_end(1) = 5
        expect(sentEvents).toHaveLength(5);
    });
});

describe('Lifecycle E2E — stale session cleanup', () => {
    beforeEach(async () => {
        sentEvents.length = 0;
        logEntries.length = 0;
        vi.clearAllMocks();
        tmpRepoRoot = await createTmpRepoRoot();
    });

    afterEach(async () => {
        await fs.rm(tmpRepoRoot, { recursive: true, force: true }).catch(() => {});
    });

    it('sends synthetic session_end for stale sessions and cleans up files', async () => {
        const sessionsDir = path.join(tmpRepoRoot, '.kody', 'sessions');
        await fs.mkdir(sessionsDir, { recursive: true });

        // Create two stale session files with old modification times
        const staleSession1 = 'stale-session-aaa';
        const staleSession2 = 'stale-session-bbb';

        const staleData = JSON.stringify({
            turnId: '999',
            transcriptPath: '/tmp/old-transcript.jsonl',
            transcriptOffset: 0,
        });

        const staleFile1 = path.join(sessionsDir, `${staleSession1}.json`);
        const staleFile2 = path.join(sessionsDir, `${staleSession2}.json`);

        await fs.writeFile(staleFile1, staleData + '\n', 'utf-8');
        await fs.writeFile(staleFile2, staleData + '\n', 'utf-8');

        // Set modification time to 45 minutes ago (threshold is 30 min)
        const fortyFiveMinAgo = new Date(Date.now() - 45 * 60 * 1000);
        await fs.utimes(staleFile1, fortyFiveMinAgo, fortyFiveMinAgo);
        await fs.utimes(staleFile2, fortyFiveMinAgo, fortyFiveMinAgo);

        // Dispatch a new SessionStart — this should trigger stale cleanup
        const newSessionId = 'new-session-fresh';
        await lifecycleService.dispatch(tmpRepoRoot, 'claude-code', {
            type: 'SessionStart',
            sessionId: newSessionId,
            sessionRef: '/tmp/new-transcript.jsonl',
            timestamp: new Date().toISOString(),
        });

        // Expect: 1 session_start for the new session + 2 synthetic session_end for stale ones
        const sessionStarts = eventsByType('session_start');
        const sessionEnds = eventsByType('session_end');

        expect(sessionStarts).toHaveLength(1);
        expect(sessionStarts[0].sessionId).toBe(newSessionId);

        expect(sessionEnds).toHaveLength(2);
        const staleSessionIds = sessionEnds.map((e) => e.sessionId).sort();
        expect(staleSessionIds).toEqual([staleSession1, staleSession2].sort());

        // All synthetic session_end events should have the correct branch
        for (const endEvent of sessionEnds) {
            expect(endEvent.branch).toBe('feat/my-feature');
        }

        // Stale session files should be removed
        await expect(fs.access(staleFile1)).rejects.toThrow();
        await expect(fs.access(staleFile2)).rejects.toThrow();

        // Verify cleanup was logged
        const cleanupLogs = logEntries.filter((l) => l.msg === 'stale-session-cleanup');
        expect(cleanupLogs).toHaveLength(2);
    });

    it('does not clean up sessions that are still fresh', async () => {
        const sessionsDir = path.join(tmpRepoRoot, '.kody', 'sessions');
        await fs.mkdir(sessionsDir, { recursive: true });

        // Create a fresh session file (just created, not stale)
        const freshSessionId = 'fresh-session-ccc';
        const freshFile = path.join(sessionsDir, `${freshSessionId}.json`);
        await fs.writeFile(
            freshFile,
            JSON.stringify({
                turnId: '100',
                transcriptPath: '/tmp/fresh.jsonl',
                transcriptOffset: 0,
            }) + '\n',
            'utf-8',
        );

        // Dispatch SessionStart
        await lifecycleService.dispatch(tmpRepoRoot, 'claude-code', {
            type: 'SessionStart',
            sessionId: 'new-session-ddd',
            sessionRef: '/tmp/t.jsonl',
            timestamp: new Date().toISOString(),
        });

        // Only the session_start event, no synthetic session_end
        expect(eventsByType('session_start')).toHaveLength(1);
        expect(eventsByType('session_end')).toHaveLength(0);

        // Fresh file should still exist
        await expect(fs.access(freshFile)).resolves.toBeUndefined();
    });
});

describe('Lifecycle E2E — synthetic turn_start', () => {
    beforeEach(async () => {
        sentEvents.length = 0;
        logEntries.length = 0;
        vi.clearAllMocks();
        tmpRepoRoot = await createTmpRepoRoot();
    });

    afterEach(async () => {
        await fs.rm(tmpRepoRoot, { recursive: true, force: true }).catch(() => {});
    });

    it('sends a synthetic turn_start before turn_end when TurnStart was never dispatched', async () => {
        const sessionId = 'orphan-turn-session';

        // Dispatch TurnEnd WITHOUT a prior TurnStart
        await lifecycleService.dispatch(tmpRepoRoot, 'claude-code', {
            type: 'TurnEnd',
            sessionId,
            sessionRef: '/tmp/transcript.jsonl',
            timestamp: new Date().toISOString(),
        });

        // Should have sent a synthetic turn_start AND a turn_end
        const turnStarts = eventsByType('turn_start');
        const turnEnds = eventsByType('turn_end');

        expect(turnStarts).toHaveLength(1);
        expect(turnEnds).toHaveLength(1);

        // The synthetic turn_start should have an empty prompt
        if (turnStarts[0].type === 'turn_start') {
            expect(turnStarts[0].prompt).toBe('');
            expect(turnStarts[0].sessionId).toBe(sessionId);
            expect(turnStarts[0].branch).toBe('feat/my-feature');
            expect(turnStarts[0].commitBefore).toBe('abc123def456');
        }

        // The turn_end should use the same turnId as the synthetic turn_start
        if (turnStarts[0].type === 'turn_start' && turnEnds[0].type === 'turn_end') {
            expect(turnEnds[0].turnId).toBe(turnStarts[0].turnId);
        }

        // Should log a warning about the missing turn_start
        const warnLog = logEntries.find((l) => l.msg === 'turn-end-without-turn-start');
        expect(warnLog).toBeDefined();
        expect(warnLog!.data.model_session_id).toBe(sessionId);

        // Local state file should exist with turnCompleted (saved even for
        // synthetic turns to prevent dedup issues)
        const localFile = path.join(
            tmpRepoRoot,
            '.kody',
            'sessions',
            `${sessionId}.json`,
        );
        const localData = JSON.parse(await fs.readFile(localFile, 'utf-8'));
        expect(localData.turnCompleted).toBe(true);
    });
});
