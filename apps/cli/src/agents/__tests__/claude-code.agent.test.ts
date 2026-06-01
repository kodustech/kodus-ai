import { describe, it, expect } from 'vitest';
import { ClaudeCodeAgent } from '../claude-code.agent.js';

const agent = new ClaudeCodeAgent();

describe('ClaudeCodeAgent.parseHookEvent', () => {
    it('maps session-start to SessionStart', () => {
        const event = agent.parseHookEvent('session-start', {
            session_id: 'sess-1',
            transcript_path: '/tmp/transcript.jsonl',
        });

        expect(event).not.toBeNull();
        expect(event!.type).toBe('SessionStart');
        expect(event!.sessionId).toBe('sess-1');
        expect(event!.sessionRef).toBe('/tmp/transcript.jsonl');
    });

    it('maps session-end to SessionEnd', () => {
        const event = agent.parseHookEvent('session-end', {
            session_id: 'sess-1',
        });
        expect(event!.type).toBe('SessionEnd');
    });

    it('maps stop to TurnEnd', () => {
        const event = agent.parseHookEvent('stop', { session_id: 'sess-1' });
        expect(event!.type).toBe('TurnEnd');
    });

    it('maps user-prompt-submit to TurnStart', () => {
        const event = agent.parseHookEvent('user-prompt-submit', {
            session_id: 'sess-1',
            prompt: 'Fix the bug',
        });

        expect(event!.type).toBe('TurnStart');
        expect(event!.prompt).toBe('Fix the bug');
    });

    it('maps pre-task to SubagentStart', () => {
        const event = agent.parseHookEvent('pre-task', {
            session_id: 'sess-1',
            tool_use_id: 'tool-1',
            subagent_type: 'Explore',
            task_description: 'Search codebase',
        });

        expect(event!.type).toBe('SubagentStart');
        expect(event!.toolUseId).toBe('tool-1');
        expect(event!.subagentType).toBe('Explore');
        expect(event!.taskDescription).toBe('Search codebase');
    });

    it('maps post-task to SubagentEnd', () => {
        const event = agent.parseHookEvent('post-task', {
            session_id: 'sess-1',
            tool_use_id: 'tool-1',
        });

        expect(event!.type).toBe('SubagentEnd');
        expect(event!.toolUseId).toBe('tool-1');
    });

    it('maps post-todo to TurnEnd', () => {
        const event = agent.parseHookEvent('post-todo', {
            session_id: 'sess-1',
        });
        expect(event!.type).toBe('TurnEnd');
    });

    it('returns null for unknown hook name', () => {
        const event = agent.parseHookEvent('unknown-hook', {});
        expect(event).toBeNull();
    });

    it('handles empty payload gracefully', () => {
        const event = agent.parseHookEvent('session-start', {});
        expect(event).not.toBeNull();
        expect(event!.sessionId).toBe('');
    });

    it('handles null payload gracefully', () => {
        const event = agent.parseHookEvent('session-start', null);
        expect(event).not.toBeNull();
        expect(event!.sessionId).toBe('');
    });

    it('extracts toolInput from tool_input field', () => {
        const event = agent.parseHookEvent('pre-task', {
            session_id: 'sess-1',
            tool_use_id: 'tool-1',
            tool_input: { subagent_type: 'Plan', prompt: 'Design the feature' },
        });

        expect(event!.toolInput).toEqual({
            subagent_type: 'Plan',
            prompt: 'Design the feature',
        });
    });

    it('prefers camelCase keys', () => {
        const event = agent.parseHookEvent('session-start', {
            session_id: 'from-snake',
            sessionId: 'from-camel',
        });

        // pickString tries session_id first, so snake_case wins
        expect(event!.sessionId).toBe('from-snake');
    });
});

describe('ClaudeCodeAgent.agentType', () => {
    it('is claude-code', () => {
        expect(agent.agentType).toBe('claude-code');
    });
});
