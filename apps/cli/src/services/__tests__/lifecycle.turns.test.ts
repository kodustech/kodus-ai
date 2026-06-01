import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
    LifecycleEvent,
    TranscriptParseResult,
} from '../../types/session.js';
import type { SessionApiEvent } from '../../types/session-events.js';

// Track sent events
const sentEvents: SessionApiEvent[] = [];

// Mock all dependencies before importing the service
vi.mock('../git.service.js', () => ({
    gitService: {
        getHeadSha: vi.fn().mockResolvedValue('abc123def456'),
        getCurrentBranch: vi.fn().mockResolvedValue('main'),
        getRemoteUrl: vi.fn().mockResolvedValue('git@github.com:org/repo.git'),
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

vi.mock('../session-local.service.js', () => {
    const store = new Map<string, unknown>();
    return {
        saveLocal: vi.fn((_repo: string, sessionId: string, data: unknown) => {
            store.set(sessionId, JSON.parse(JSON.stringify(data)));
            return Promise.resolve();
        }),
        loadLocal: vi.fn((_repo: string, sessionId: string) => {
            return Promise.resolve(store.get(sessionId) ?? null);
        }),
        removeLocal: vi.fn((_repo: string, sessionId: string) => {
            store.delete(sessionId);
            return Promise.resolve();
        }),
        listStaleSessions: vi.fn().mockResolvedValue([]),
        _store: store,
    };
});

vi.mock('../api/index.js', () => ({
    api: {
        sessions: {
            sendEvent: vi.fn((event: SessionApiEvent) => {
                sentEvents.push(JSON.parse(JSON.stringify(event)));
                return Promise.resolve();
            }),
        },
    },
}));

const mockParseResult: TranscriptParseResult = {
    prompts: ['test prompt'],
    assistantMessages: ['test response'],
    modifiedFiles: ['src/auth.ts', 'src/config.ts'],
    tokenUsage: {
        inputTokens: 500,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        apiCallCount: 2,
    },
    summary: 'test response',
    subagentIds: [],
    entryCount: 5,
    toolCalls: [
        {
            toolName: 'Write',
            toolUseId: 'tu1',
            timestamp: '2026-03-03T00:00:00Z',
            input: { file_path: 'src/auth.ts' },
            isMcp: false,
            fileAffected: 'src/auth.ts',
        },
        {
            toolName: 'Read',
            toolUseId: 'tu2',
            timestamp: '2026-03-03T00:00:00Z',
            input: { file_path: 'src/old.ts' },
            isMcp: false,
            fileAffected: 'src/old.ts',
        },
        {
            toolName: 'Bash',
            toolUseId: 'tu3',
            timestamp: '2026-03-03T00:00:00Z',
            input: { command: 'npm test' },
            isMcp: false,
        },
    ],
    filesRead: ['src/old.ts'],
    commands: ['npm test'],
};

vi.mock('../transcript.service.js', () => ({
    transcriptService: {
        waitForFlush: vi.fn().mockResolvedValue(true),
        parse: vi.fn().mockResolvedValue(mockParseResult),
    },
}));

// Import after mocks
const { lifecycleService } = await import('../lifecycle.service.js');
const { saveLocal, removeLocal, _store } =
    (await import('../session-local.service.js')) as any;

describe('Lifecycle API event dispatch', () => {
    const repoRoot = '/tmp/test-repo';
    const sessionId = 'test-session-abc123';

    beforeEach(() => {
        sentEvents.length = 0;
        _store.clear();
        vi.clearAllMocks();
    });

    it('sends session_start event', async () => {
        const event: LifecycleEvent = {
            type: 'SessionStart',
            sessionId,
            sessionRef: '/tmp/transcript.jsonl',
            timestamp: new Date().toISOString(),
        };

        await lifecycleService.dispatch(repoRoot, 'claude-code', event);

        expect(sentEvents).toHaveLength(1);
        expect(sentEvents[0].type).toBe('session_start');
        expect(sentEvents[0].sessionId).toBe(sessionId);
        if (sentEvents[0].type === 'session_start') {
            expect(sentEvents[0].branch).toBe('main');
            expect(sentEvents[0].baseCommit).toBe('abc123def456');
            expect(sentEvents[0].gitRemote).toBe('git@github.com:org/repo.git');
            expect(sentEvents[0].agentType).toBe('claude-code');
        }
    });

    it('sends turn_start event and saves local state', async () => {
        const event: LifecycleEvent = {
            type: 'TurnStart',
            sessionId,
            sessionRef: '/tmp/transcript.jsonl',
            prompt: 'create a login endpoint',
            timestamp: new Date().toISOString(),
        };

        await lifecycleService.dispatch(repoRoot, 'claude-code', event);

        expect(sentEvents).toHaveLength(1);
        expect(sentEvents[0].type).toBe('turn_start');
        if (sentEvents[0].type === 'turn_start') {
            expect(sentEvents[0].prompt).toBe('create a login endpoint');
            expect(sentEvents[0].commitBefore).toBe('abc123def456');
            expect(sentEvents[0].turnId).toBeTruthy();
        }

        // Local state should be saved
        expect(saveLocal).toHaveBeenCalledWith(
            repoRoot,
            sessionId,
            expect.objectContaining({ turnId: expect.any(String) }),
        );
    });

    it('sends turn_end event with transcript data', async () => {
        // First: TurnStart to set up local state
        await lifecycleService.dispatch(repoRoot, 'claude-code', {
            type: 'TurnStart',
            sessionId,
            sessionRef: '/tmp/transcript.jsonl',
            prompt: 'create a login endpoint',
            timestamp: new Date().toISOString(),
        });

        const turnStartEvent = sentEvents[0];
        const turnId =
            turnStartEvent.type === 'turn_start' ? turnStartEvent.turnId : '';

        // Then: TurnEnd
        await lifecycleService.dispatch(repoRoot, 'claude-code', {
            type: 'TurnEnd',
            sessionId,
            sessionRef: '/tmp/transcript.jsonl',
            timestamp: new Date().toISOString(),
        });

        expect(sentEvents).toHaveLength(2);
        const turnEnd = sentEvents[1];
        expect(turnEnd.type).toBe('turn_end');
        if (turnEnd.type === 'turn_end') {
            expect(turnEnd.turnId).toBe(turnId);
            expect(turnEnd.toolCalls).toHaveLength(3);
            expect(turnEnd.toolCalls[0].toolName).toBe('Write');
            expect(turnEnd.toolCalls[1].toolName).toBe('Read');
            expect(turnEnd.toolCalls[2].toolName).toBe('Bash');
            expect(turnEnd.filesModified).toHaveLength(2);
            expect(turnEnd.filesModified.map((f) => f.path)).toContain(
                'src/auth.ts',
            );
            expect(turnEnd.filesModified.map((f) => f.path)).toContain(
                'src/config.ts',
            );
            expect(turnEnd.filesRead).toEqual(['src/old.ts']);
            expect(turnEnd.commands).toEqual(['npm test']);
            expect(turnEnd.response).toBe('test response');
            expect(turnEnd.tokenUsage.inputTokens).toBe(500);
            expect(turnEnd.tokenUsage.outputTokens).toBe(100);
            expect(turnEnd.commitAfter).toBe('abc123def456');
        }
    });

    it('sends session_end event and cleans up local state', async () => {
        // Set up local state first
        await lifecycleService.dispatch(repoRoot, 'claude-code', {
            type: 'TurnStart',
            sessionId,
            sessionRef: '/tmp/transcript.jsonl',
            prompt: 'test',
            timestamp: new Date().toISOString(),
        });

        await lifecycleService.dispatch(repoRoot, 'claude-code', {
            type: 'SessionEnd',
            sessionId,
            sessionRef: '/tmp/transcript.jsonl',
            timestamp: new Date().toISOString(),
        });

        const sessionEnd = sentEvents.find((e) => e.type === 'session_end');
        expect(sessionEnd).toBeDefined();
        expect(sessionEnd!.branch).toBe('main');

        expect(removeLocal).toHaveBeenCalledWith(repoRoot, sessionId);
    });

    it('sends subagent_start event', async () => {
        await lifecycleService.dispatch(repoRoot, 'claude-code', {
            type: 'SubagentStart',
            sessionId,
            sessionRef: '/tmp/transcript.jsonl',
            timestamp: new Date().toISOString(),
            toolUseId: 'tool-123',
            subagentType: 'Explore',
            taskDescription: 'Find authentication files',
        });

        expect(sentEvents).toHaveLength(1);
        const event = sentEvents[0];
        expect(event.type).toBe('subagent_start');
        if (event.type === 'subagent_start') {
            expect(event.toolUseId).toBe('tool-123');
            expect(event.subagentType).toBe('Explore');
            expect(event.taskDescription).toBe('Find authentication files');
        }
    });

    it('sends subagent_end event', async () => {
        await lifecycleService.dispatch(repoRoot, 'claude-code', {
            type: 'SubagentEnd',
            sessionId,
            sessionRef: '/tmp/transcript.jsonl',
            timestamp: new Date().toISOString(),
            toolUseId: 'tool-123',
        });

        expect(sentEvents).toHaveLength(1);
        expect(sentEvents[0].type).toBe('subagent_end');
        if (sentEvents[0].type === 'subagent_end') {
            expect(sentEvents[0].toolUseId).toBe('tool-123');
        }
    });

    it('skips subagent events without toolUseId', async () => {
        await lifecycleService.dispatch(repoRoot, 'claude-code', {
            type: 'SubagentStart',
            sessionId,
            sessionRef: '/tmp/transcript.jsonl',
            timestamp: new Date().toISOString(),
        });

        expect(sentEvents).toHaveLength(0);
    });

    it('includes branch in every event', async () => {
        await lifecycleService.dispatch(repoRoot, 'claude-code', {
            type: 'SessionStart',
            sessionId,
            sessionRef: '/tmp/t.jsonl',
            timestamp: new Date().toISOString(),
        });
        await lifecycleService.dispatch(repoRoot, 'claude-code', {
            type: 'TurnStart',
            sessionId,
            sessionRef: '/tmp/t.jsonl',
            prompt: 'test',
            timestamp: new Date().toISOString(),
        });
        await lifecycleService.dispatch(repoRoot, 'claude-code', {
            type: 'TurnEnd',
            sessionId,
            sessionRef: '/tmp/t.jsonl',
            timestamp: new Date().toISOString(),
        });
        await lifecycleService.dispatch(repoRoot, 'claude-code', {
            type: 'SessionEnd',
            sessionId,
            sessionRef: '/tmp/t.jsonl',
            timestamp: new Date().toISOString(),
        });

        for (const event of sentEvents) {
            expect(event.branch).toBe('main');
        }
    });
});
