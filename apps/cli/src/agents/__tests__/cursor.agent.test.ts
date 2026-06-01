import { describe, it, expect } from 'vitest';
import { CursorAgent } from '../cursor.agent.js';

const agent = new CursorAgent();

describe('CursorAgent.parseHookEvent', () => {
    it('maps sessionStart to SessionStart', () => {
        const event = agent.parseHookEvent('sessionStart', {
            session_id: 'sess-1',
        });

        expect(event).not.toBeNull();
        expect(event!.type).toBe('SessionStart');
        expect(event!.sessionId).toBe('sess-1');
    });

    it('maps sessionEnd to SessionEnd', () => {
        const event = agent.parseHookEvent('sessionEnd', {
            session_id: 'sess-1',
        });
        expect(event!.type).toBe('SessionEnd');
    });

    it('maps beforeSubmitPrompt to TurnStart', () => {
        const event = agent.parseHookEvent('beforeSubmitPrompt', {
            session_id: 'sess-1',
            prompt: 'Fix the bug',
        });

        expect(event!.type).toBe('TurnStart');
        expect(event!.prompt).toBe('Fix the bug');
    });

    it('maps stop to TurnEnd', () => {
        const event = agent.parseHookEvent('stop', {
            session_id: 'sess-1',
        });
        expect(event!.type).toBe('TurnEnd');
    });

    it('maps subagentStart to SubagentStart', () => {
        const event = agent.parseHookEvent('subagentStart', {
            session_id: 'sess-1',
            subagent_id: 'sub-1',
            subagent_type: 'Explore',
            task_description: 'Search codebase',
        });

        expect(event!.type).toBe('SubagentStart');
        expect(event!.subagentId).toBe('sub-1');
        expect(event!.subagentType).toBe('Explore');
        expect(event!.taskDescription).toBe('Search codebase');
    });

    it('maps subagentStop to SubagentEnd', () => {
        const event = agent.parseHookEvent('subagentStop', {
            session_id: 'sess-1',
            subagent_id: 'sub-1',
            subagent_type: 'Explore',
        });

        expect(event!.type).toBe('SubagentEnd');
        expect(event!.subagentId).toBe('sub-1');
        expect(event!.subagentType).toBe('Explore');
    });

    it('returns null for unknown hook name', () => {
        const event = agent.parseHookEvent('unknown-hook', {});
        expect(event).toBeNull();
    });

    it('extracts session_id from snake_case payload', () => {
        const event = agent.parseHookEvent('sessionStart', {
            session_id: 'snake-id',
        });
        expect(event!.sessionId).toBe('snake-id');
    });

    it('extracts sessionId from camelCase payload', () => {
        const event = agent.parseHookEvent('sessionStart', {
            sessionId: 'camel-id',
        });
        expect(event!.sessionId).toBe('camel-id');
    });

    it('prefers snake_case session_id over camelCase', () => {
        const event = agent.parseHookEvent('sessionStart', {
            session_id: 'from-snake',
            sessionId: 'from-camel',
        });
        expect(event!.sessionId).toBe('from-snake');
    });

    it('extracts prompt from payload', () => {
        const event = agent.parseHookEvent('beforeSubmitPrompt', {
            session_id: 'sess-1',
            prompt: 'Refactor the module',
        });
        expect(event!.prompt).toBe('Refactor the module');
    });

    it('extracts subagent_id and subagent_type for subagent hooks', () => {
        const event = agent.parseHookEvent('subagentStart', {
            session_id: 'sess-1',
            subagent_id: 'agent-42',
            subagent_type: 'Plan',
        });

        expect(event!.subagentId).toBe('agent-42');
        expect(event!.subagentType).toBe('Plan');
        expect(event!.toolUseId).toBe('agent-42');
    });

    it('handles empty payload gracefully', () => {
        const event = agent.parseHookEvent('sessionStart', {});
        expect(event).not.toBeNull();
        expect(event!.sessionId).toBe('');
    });

    it('handles null payload gracefully', () => {
        const event = agent.parseHookEvent('sessionStart', null);
        expect(event).not.toBeNull();
        expect(event!.sessionId).toBe('');
    });
});

describe('CursorAgent.agentType', () => {
    it('is cursor', () => {
        expect(agent.agentType).toBe('cursor');
    });
});
