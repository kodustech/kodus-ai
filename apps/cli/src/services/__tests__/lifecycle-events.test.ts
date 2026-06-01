import { describe, expect, it } from 'vitest';
import type {
    AgentType,
    FileChange,
    LifecycleEvent,
    TokenUsage,
    ToolCall,
} from '../../types/session.js';
import type { SessionApiEvent } from '../../types/session-events.js';
import {
    buildSessionEndEvent,
    buildSessionStartEvent,
    buildSubagentEndEvent,
    buildSubagentStartEvent,
    buildTurnEndEvent,
    buildTurnStartEvent,
} from '../lifecycle-events.js';

const agentType: AgentType = 'claude-code';
const timestamp = '2026-03-14T12:00:00.000Z';

describe('lifecycle event builders', () => {
    it('builds session_start payload', () => {
        const event = buildSessionStartEvent({
            sessionId: 'sess-1',
            branch: 'main',
            agentType,
            gitRemote: 'git@github.com:org/repo.git',
            baseCommit: 'abc123',
            cliVersion: '1.2.3',
            timestamp,
        });

        expect(event).toEqual<SessionApiEvent>({
            type: 'session_start',
            sessionId: 'sess-1',
            branch: 'main',
            agentType,
            gitRemote: 'git@github.com:org/repo.git',
            baseCommit: 'abc123',
            cliVersion: '1.2.3',
            timestamp,
        });
    });

    it('builds turn_start payload', () => {
        const event = buildTurnStartEvent({
            sessionId: 'sess-1',
            branch: 'main',
            turnId: 'turn-1',
            prompt: 'Fix auth bug',
            commitBefore: 'abc123',
            timestamp,
        });

        expect(event).toEqual<SessionApiEvent>({
            type: 'turn_start',
            sessionId: 'sess-1',
            branch: 'main',
            turnId: 'turn-1',
            prompt: 'Fix auth bug',
            commitBefore: 'abc123',
            timestamp,
        });
    });

    it('builds turn_end payload', () => {
        const toolCalls: ToolCall[] = [];
        const filesModified: FileChange[] = [
            { path: 'src/auth.ts', action: 'modified' },
        ];
        const tokenUsage: TokenUsage = {
            inputTokens: 10,
            outputTokens: 20,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            apiCallCount: 1,
        };

        const event = buildTurnEndEvent({
            sessionId: 'sess-1',
            branch: 'main',
            turnId: 'turn-1',
            response: 'Done',
            toolCalls,
            filesModified,
            filesRead: ['src/old.ts'],
            commands: ['npm test'],
            tokenUsage,
            commitAfter: 'def456',
            timestamp,
        });

        expect(event).toEqual<SessionApiEvent>({
            type: 'turn_end',
            sessionId: 'sess-1',
            branch: 'main',
            turnId: 'turn-1',
            response: 'Done',
            toolCalls,
            filesModified,
            filesRead: ['src/old.ts'],
            commands: ['npm test'],
            tokenUsage,
            commitAfter: 'def456',
            timestamp,
        });
    });

    it('builds session_end payload', () => {
        const event = buildSessionEndEvent({
            sessionId: 'sess-1',
            branch: 'main',
            timestamp,
        });

        expect(event).toEqual<SessionApiEvent>({
            type: 'session_end',
            sessionId: 'sess-1',
            branch: 'main',
            timestamp,
        });
    });

    it('builds subagent_start payload using explicit event fields', () => {
        const lifecycleEvent: LifecycleEvent = {
            type: 'SubagentStart',
            sessionId: 'sess-1',
            sessionRef: '/tmp/transcript.jsonl',
            timestamp,
            toolUseId: 'tool-1',
            subagentType: 'Explore',
            taskDescription: 'Inspect auth flow',
        };

        const event = buildSubagentStartEvent({
            event: lifecycleEvent,
            branch: 'main',
            timestamp,
        });

        expect(event).toEqual<SessionApiEvent>({
            type: 'subagent_start',
            sessionId: 'sess-1',
            branch: 'main',
            toolUseId: 'tool-1',
            subagentType: 'Explore',
            taskDescription: 'Inspect auth flow',
            timestamp,
        });
    });

    it('builds subagent_start payload using toolInput fallbacks', () => {
        const lifecycleEvent: LifecycleEvent = {
            type: 'SubagentStart',
            sessionId: 'sess-1',
            sessionRef: '/tmp/transcript.jsonl',
            timestamp,
            toolUseId: 'tool-1',
            toolInput: {
                subagent_type: 'Implement',
                task_description: 'Apply fix',
            },
        };

        const event = buildSubagentStartEvent({
            event: lifecycleEvent,
            branch: 'main',
            timestamp,
        });

        expect(event).toEqual<SessionApiEvent>({
            type: 'subagent_start',
            sessionId: 'sess-1',
            branch: 'main',
            toolUseId: 'tool-1',
            subagentType: 'Implement',
            taskDescription: 'Apply fix',
            timestamp,
        });
    });

    it('builds subagent_end payload', () => {
        const event = buildSubagentEndEvent({
            sessionId: 'sess-1',
            branch: 'main',
            toolUseId: 'tool-1',
            timestamp,
        });

        expect(event).toEqual<SessionApiEvent>({
            type: 'subagent_end',
            sessionId: 'sess-1',
            branch: 'main',
            toolUseId: 'tool-1',
            timestamp,
        });
    });
});
