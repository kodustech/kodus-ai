import { describe, it, expect } from 'vitest';
import { ClaudeCodeAgent } from '../claude-code.agent.js';
import { CursorAgent } from '../cursor.agent.js';
import { CodexAgent } from '../codex.agent.js';
import type { LifecycleEvent } from '../../types/session.js';

// ---------------------------------------------------------------------------
// Realistic payloads matching what each IDE ACTUALLY sends to hook stdin.
// These serve as contract tests — if an IDE changes its payload format,
// these tests should catch the regression.
// ---------------------------------------------------------------------------

// ========================= Claude Code Payloads ============================

const claudeSessionStart = {
    session_id: 'abc-123-def',
    transcript_path: '/Users/dev/.claude/projects/myproject/abc-123.jsonl',
};

const claudeUserPrompt = {
    session_id: 'abc-123-def',
    transcript_path: '/Users/dev/.claude/projects/myproject/abc-123.jsonl',
    prompt: 'Fix the authentication bug in auth.ts',
};

const claudeStop = {
    session_id: 'abc-123-def',
    transcript_path: '/Users/dev/.claude/projects/myproject/abc-123.jsonl',
    stop_reason: 'end_turn',
};

const claudeSessionEnd = {
    session_id: 'abc-123-def',
    transcript_path: '/Users/dev/.claude/projects/myproject/abc-123.jsonl',
};

const claudeSubagentStart = {
    session_id: 'abc-123-def',
    subagent_id: 'sub-456',
    subagent_type: 'Explore',
    task_description: 'Find all authentication files',
    tool_use_id: 'toolu_abc123',
};

const claudeSubagentStop = {
    session_id: 'abc-123-def',
    subagent_id: 'sub-456',
    tool_use_id: 'toolu_abc123',
};

const claudePostTodo = {
    session_id: 'abc-123-def',
    tool_use_id: 'toolu_xyz789',
    tool_input: {
        todos: [{ id: '1', content: 'Fix auth', status: 'in_progress' }],
    },
};

// ============================ Cursor Payloads ==============================

const cursorSessionStart = {
    sessionId: 'cursor-sess-789',
};

const cursorBeforeSubmitPrompt = {
    sessionId: 'cursor-sess-789',
    prompt: 'Refactor the database layer',
};

const cursorStop = {
    sessionId: 'cursor-sess-789',
};

const cursorSessionEnd = {
    sessionId: 'cursor-sess-789',
};

const cursorSubagentStart = {
    sessionId: 'cursor-sess-789',
    subagentId: 'agent-001',
    subagentType: 'codebase-search',
    taskDescription: 'Search for related files',
};

const cursorSubagentStop = {
    sessionId: 'cursor-sess-789',
    subagentId: 'agent-001',
};

// ============================= Codex Payloads ==============================

const codexAfterAgent = {
    thread_id: 'thread_abc123',
    conversation_id: 'conv_xyz',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

function expectValidEvent(event: LifecycleEvent | null): asserts event is LifecycleEvent {
    expect(event).not.toBeNull();
    expect(event!.timestamp).toMatch(ISO_REGEX);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Payload Compatibility: Claude Code', () => {
    const agent = new ClaudeCodeAgent();

    it('session-start: produces SessionStart with sessionId and sessionRef', () => {
        const event = agent.parseHookEvent('session-start', claudeSessionStart);
        expectValidEvent(event);
        expect(event.type).toBe('SessionStart');
        expect(event.sessionId).toBe('abc-123-def');
        expect(event.sessionRef).toBe(
            '/Users/dev/.claude/projects/myproject/abc-123.jsonl',
        );
    });

    it('user-prompt-submit: produces TurnStart with prompt', () => {
        const event = agent.parseHookEvent('user-prompt-submit', claudeUserPrompt);
        expectValidEvent(event);
        expect(event.type).toBe('TurnStart');
        expect(event.sessionId).toBe('abc-123-def');
        expect(event.prompt).toBe('Fix the authentication bug in auth.ts');
        expect(event.sessionRef).toBe(
            '/Users/dev/.claude/projects/myproject/abc-123.jsonl',
        );
    });

    it('stop: produces TurnEnd with sessionId', () => {
        const event = agent.parseHookEvent('stop', claudeStop);
        expectValidEvent(event);
        expect(event.type).toBe('TurnEnd');
        expect(event.sessionId).toBe('abc-123-def');
        expect(event.sessionRef).toBe(
            '/Users/dev/.claude/projects/myproject/abc-123.jsonl',
        );
    });

    it('session-end: produces SessionEnd', () => {
        const event = agent.parseHookEvent('session-end', claudeSessionEnd);
        expectValidEvent(event);
        expect(event.type).toBe('SessionEnd');
        expect(event.sessionId).toBe('abc-123-def');
    });

    it('subagent-start: produces SubagentStart with all subagent fields', () => {
        const event = agent.parseHookEvent('subagent-start', claudeSubagentStart);
        expectValidEvent(event);
        expect(event.type).toBe('SubagentStart');
        expect(event.sessionId).toBe('abc-123-def');
        expect(event.subagentId).toBe('sub-456');
        expect(event.subagentType).toBe('Explore');
        expect(event.taskDescription).toBe('Find all authentication files');
        expect(event.toolUseId).toBe('toolu_abc123');
    });

    it('subagent-stop: produces SubagentEnd with subagentId and toolUseId', () => {
        const event = agent.parseHookEvent('subagent-stop', claudeSubagentStop);
        expectValidEvent(event);
        expect(event.type).toBe('SubagentEnd');
        expect(event.subagentId).toBe('sub-456');
        expect(event.toolUseId).toBe('toolu_abc123');
    });

    it('post-todo: produces TurnEnd with toolInput containing todos', () => {
        const event = agent.parseHookEvent('post-todo', claudePostTodo);
        expectValidEvent(event);
        expect(event.type).toBe('TurnEnd');
        expect(event.toolUseId).toBe('toolu_xyz789');
        expect(event.toolInput).toEqual({
            todos: [{ id: '1', content: 'Fix auth', status: 'in_progress' }],
        });
    });

    it('legacy pre-task maps to SubagentStart', () => {
        const event = agent.parseHookEvent('pre-task', claudeSubagentStart);
        expectValidEvent(event);
        expect(event.type).toBe('SubagentStart');
    });

    it('legacy post-task maps to SubagentEnd', () => {
        const event = agent.parseHookEvent('post-task', claudeSubagentStop);
        expectValidEvent(event);
        expect(event.type).toBe('SubagentEnd');
    });
});

describe('Payload Compatibility: Cursor', () => {
    const agent = new CursorAgent();

    it('sessionStart: produces SessionStart with sessionId', () => {
        const event = agent.parseHookEvent('sessionStart', cursorSessionStart);
        expectValidEvent(event);
        expect(event.type).toBe('SessionStart');
        expect(event.sessionId).toBe('cursor-sess-789');
        expect(event.sessionRef).toBe('');
    });

    it('beforeSubmitPrompt: produces TurnStart with prompt', () => {
        const event = agent.parseHookEvent(
            'beforeSubmitPrompt',
            cursorBeforeSubmitPrompt,
        );
        expectValidEvent(event);
        expect(event.type).toBe('TurnStart');
        expect(event.sessionId).toBe('cursor-sess-789');
        expect(event.prompt).toBe('Refactor the database layer');
    });

    it('stop: produces TurnEnd', () => {
        const event = agent.parseHookEvent('stop', cursorStop);
        expectValidEvent(event);
        expect(event.type).toBe('TurnEnd');
        expect(event.sessionId).toBe('cursor-sess-789');
    });

    it('sessionEnd: produces SessionEnd', () => {
        const event = agent.parseHookEvent('sessionEnd', cursorSessionEnd);
        expectValidEvent(event);
        expect(event.type).toBe('SessionEnd');
        expect(event.sessionId).toBe('cursor-sess-789');
    });

    it('subagentStart: produces SubagentStart with all subagent fields', () => {
        const event = agent.parseHookEvent('subagentStart', cursorSubagentStart);
        expectValidEvent(event);
        expect(event.type).toBe('SubagentStart');
        expect(event.sessionId).toBe('cursor-sess-789');
        expect(event.subagentId).toBe('agent-001');
        expect(event.subagentType).toBe('codebase-search');
        expect(event.taskDescription).toBe('Search for related files');
    });

    it('subagentStop: produces SubagentEnd with subagentId', () => {
        const event = agent.parseHookEvent('subagentStop', cursorSubagentStop);
        expectValidEvent(event);
        expect(event.type).toBe('SubagentEnd');
        expect(event.subagentId).toBe('agent-001');
    });
});

describe('Payload Compatibility: Codex', () => {
    const agent = new CodexAgent();

    it('AfterAgent: produces TurnEnd with thread_id as sessionId', () => {
        const event = agent.parseHookEvent('AfterAgent', codexAfterAgent);
        expectValidEvent(event);
        expect(event.type).toBe('TurnEnd');
        expect(event.sessionId).toBe('thread_abc123');
        expect(event.sessionRef).toBe('');
    });

    it('AfterAgent: falls back to conversation_id when thread_id is absent', () => {
        const event = agent.parseHookEvent('AfterAgent', {
            conversation_id: 'conv_fallback',
        });
        expectValidEvent(event);
        expect(event.sessionId).toBe('conv_fallback');
    });

    it('AfterToolUse: returns null (not mapped to lifecycle event)', () => {
        const event = agent.parseHookEvent('AfterToolUse', {
            thread_id: 'thread_abc123',
        });
        expect(event).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe('Payload Compatibility: Edge Cases', () => {
    const claude = new ClaudeCodeAgent();
    const cursor = new CursorAgent();
    const codex = new CodexAgent();

    describe('extra unknown fields do not crash parsing', () => {
        it('Claude Code: extra fields are ignored', () => {
            const payload = {
                ...claudeSessionStart,
                unknown_field: 'should be ignored',
                nested: { deep: true },
                numeric: 42,
            };
            const event = claude.parseHookEvent('session-start', payload);
            expectValidEvent(event);
            expect(event.sessionId).toBe('abc-123-def');
        });

        it('Cursor: extra fields are ignored', () => {
            const payload = {
                ...cursorSessionStart,
                is_background_agent: true,
                composer_mode: 'agent',
                extra: [1, 2, 3],
            };
            const event = cursor.parseHookEvent('sessionStart', payload);
            expectValidEvent(event);
            expect(event.sessionId).toBe('cursor-sess-789');
        });

        it('Codex: extra fields are ignored', () => {
            const payload = {
                ...codexAfterAgent,
                model: 'o3',
                tokens_used: 1500,
            };
            const event = codex.parseHookEvent('AfterAgent', payload);
            expectValidEvent(event);
            expect(event.sessionId).toBe('thread_abc123');
        });
    });

    describe('missing optional fields produce valid events', () => {
        it('Claude Code: subagent-start without task_description', () => {
            const event = claude.parseHookEvent('subagent-start', {
                session_id: 'sess-1',
                subagent_id: 'sub-1',
                subagent_type: 'Explore',
                tool_use_id: 'toolu_1',
                // no task_description
            });
            expectValidEvent(event);
            expect(event.type).toBe('SubagentStart');
            expect(event.taskDescription).toBeUndefined();
        });

        it('Claude Code: user-prompt-submit without prompt', () => {
            const event = claude.parseHookEvent('user-prompt-submit', {
                session_id: 'sess-1',
                transcript_path: '/tmp/t.jsonl',
                // no prompt
            });
            expectValidEvent(event);
            expect(event.type).toBe('TurnStart');
            expect(event.prompt).toBeUndefined();
        });

        it('Cursor: subagentStart without taskDescription', () => {
            const event = cursor.parseHookEvent('subagentStart', {
                sessionId: 'sess-1',
                subagentId: 'sub-1',
                subagentType: 'search',
            });
            expectValidEvent(event);
            expect(event.taskDescription).toBeUndefined();
        });

        it('Codex: AfterAgent with no IDs at all', () => {
            const event = codex.parseHookEvent('AfterAgent', {});
            expectValidEvent(event);
            expect(event.sessionId).toBe('');
        });
    });

    describe('empty object payload produces event with empty strings', () => {
        it('Claude Code: empty object', () => {
            const event = claude.parseHookEvent('session-start', {});
            expectValidEvent(event);
            expect(event.sessionId).toBe('');
            expect(event.sessionRef).toBe('');
        });

        it('Cursor: empty object', () => {
            const event = cursor.parseHookEvent('sessionStart', {});
            expectValidEvent(event);
            expect(event.sessionId).toBe('');
            expect(event.sessionRef).toBe('');
        });

        it('Codex: empty object', () => {
            const event = codex.parseHookEvent('AfterAgent', {});
            expectValidEvent(event);
            expect(event.sessionId).toBe('');
        });
    });

    describe('null and non-object payloads do not crash', () => {
        it('Claude Code: null payload', () => {
            const event = claude.parseHookEvent('session-start', null);
            expectValidEvent(event);
            expect(event.sessionId).toBe('');
        });

        it('Cursor: undefined payload', () => {
            const event = cursor.parseHookEvent('sessionStart', undefined);
            expectValidEvent(event);
            expect(event.sessionId).toBe('');
        });

        it('Codex: array payload', () => {
            const event = codex.parseHookEvent('AfterAgent', [1, 2, 3]);
            expectValidEvent(event);
            expect(event.sessionId).toBe('');
        });

        it('Claude Code: string payload', () => {
            const event = claude.parseHookEvent('session-start', 'not an object');
            expectValidEvent(event);
            expect(event.sessionId).toBe('');
        });
    });

    describe('unknown hook names return null for all agents', () => {
        it('Claude Code: unknown hook', () => {
            expect(claude.parseHookEvent('nonexistent', {})).toBeNull();
        });

        it('Cursor: unknown hook', () => {
            expect(cursor.parseHookEvent('nonexistent', {})).toBeNull();
        });

        it('Codex: unknown hook', () => {
            expect(codex.parseHookEvent('nonexistent', {})).toBeNull();
        });
    });
});
