import { describe, it, expect } from 'vitest';
import { CodexAgent } from '../codex.agent.js';

const agent = new CodexAgent();

describe('CodexAgent.parseHookEvent', () => {
    it('maps AfterAgent to TurnEnd', () => {
        const event = agent.parseHookEvent('AfterAgent', {
            session_id: 'sess-1',
        });

        expect(event).not.toBeNull();
        expect(event!.type).toBe('TurnEnd');
        expect(event!.sessionId).toBe('sess-1');
    });

    it('returns null for AfterToolUse (not mapped to lifecycle event)', () => {
        const event = agent.parseHookEvent('AfterToolUse', {
            session_id: 'sess-1',
        });
        expect(event).toBeNull();
    });

    it('returns null for unknown hook name', () => {
        const event = agent.parseHookEvent('unknown-hook', {});
        expect(event).toBeNull();
    });

    it('extracts session_id from payload', () => {
        const event = agent.parseHookEvent('AfterAgent', {
            session_id: 'direct-id',
        });
        expect(event!.sessionId).toBe('direct-id');
    });

    it('falls back to thread_id when session_id is absent', () => {
        const event = agent.parseHookEvent('AfterAgent', {
            thread_id: 'thread-42',
        });
        expect(event!.sessionId).toBe('thread-42');
    });

    it('falls back to conversation_id when session_id and thread_id are absent', () => {
        const event = agent.parseHookEvent('AfterAgent', {
            conversation_id: 'conv-99',
        });
        expect(event!.sessionId).toBe('conv-99');
    });

    it('prefers session_id over thread_id and conversation_id', () => {
        const event = agent.parseHookEvent('AfterAgent', {
            session_id: 'sess-priority',
            thread_id: 'thread-lower',
            conversation_id: 'conv-lowest',
        });
        expect(event!.sessionId).toBe('sess-priority');
    });

    it('handles empty payload gracefully', () => {
        const event = agent.parseHookEvent('AfterAgent', {});
        expect(event).not.toBeNull();
        expect(event!.sessionId).toBe('');
    });

    it('handles null payload gracefully', () => {
        const event = agent.parseHookEvent('AfterAgent', null);
        expect(event).not.toBeNull();
        expect(event!.sessionId).toBe('');
    });
});

describe('CodexAgent.agentType', () => {
    it('is codex', () => {
        expect(agent.agentType).toBe('codex');
    });
});
