/**
 * Contract tests — validate that the payloads the CLI actually sends
 * pass DTO validation and are correctly destructured into envelope + payload.
 *
 * If these tests break, the CLI and API are out of sync.
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SessionEventRequestDto } from '../session-event.dto';
import { SESSION_EVENT_TYPES } from '@libs/cli-review/infrastructure/repositories/schemas/session-event.model';

function toDto(plain: Record<string, unknown>): SessionEventRequestDto {
    return plainToInstance(SessionEventRequestDto, plain);
}

function splitEnvelope(body: Record<string, unknown>) {
    const { sessionId, type, branch, timestamp, ...rest } = body;
    return { envelope: { sessionId, type, branch, timestamp }, payload: rest };
}

// ---------------------------------------------------------------------------
// These payloads mirror exactly what lifecycle.service.ts sends from the CLI
// ---------------------------------------------------------------------------

const CLI_SESSION_START = {
    type: 'session_start',
    sessionId: 'sess-abc123',
    branch: 'feat/auth',
    timestamp: '2025-06-01T10:30:00.000Z',
    agentType: 'claude-code',
    gitRemote: 'git@github.com:org/repo.git',
    baseCommit: 'abc123def456',
    cliVersion: '0.2.4',
};

const CLI_TURN_START = {
    type: 'turn_start',
    sessionId: 'sess-abc123',
    branch: 'feat/auth',
    timestamp: '2025-06-01T10:31:00.000Z',
    turnId: '1717234260000',
    prompt: 'Fix the authentication bug',
    commitBefore: 'abc123def456',
};

const CLI_TURN_END = {
    type: 'turn_end',
    sessionId: 'sess-abc123',
    branch: 'feat/auth',
    timestamp: '2025-06-01T10:35:00.000Z',
    turnId: '1717234260000',
    toolCalls: [
        {
            toolName: 'Read',
            toolUseId: 'tool-1',
            timestamp: '2025-06-01T10:32:00.000Z',
            input: { file_path: '/src/auth.ts' },
            isMcp: false,
        },
    ],
    filesModified: [{ path: 'src/auth.ts', action: 'modified' }],
    filesRead: ['src/auth.ts'],
    commands: ['npm test'],
    tokenUsage: {
        inputTokens: 1200,
        cacheCreationTokens: 0,
        cacheReadTokens: 500,
        outputTokens: 300,
        apiCallCount: 3,
    },
    commitAfter: 'def456abc789',
};

const CLI_SUBAGENT_START = {
    type: 'subagent_start',
    sessionId: 'sess-abc123',
    branch: 'feat/auth',
    timestamp: '2025-06-01T10:33:00.000Z',
    toolUseId: 'tool-2',
    subagentType: 'Explore',
    taskDescription: 'Find all authentication controllers',
};

const CLI_SUBAGENT_END = {
    type: 'subagent_end',
    sessionId: 'sess-abc123',
    branch: 'feat/auth',
    timestamp: '2025-06-01T10:34:00.000Z',
    toolUseId: 'tool-2',
};

const CLI_SESSION_END = {
    type: 'session_end',
    sessionId: 'sess-abc123',
    branch: 'feat/auth',
    timestamp: '2025-06-01T10:40:00.000Z',
};

const ALL_CLI_EVENTS = [
    { name: 'session_start', payload: CLI_SESSION_START },
    { name: 'turn_start', payload: CLI_TURN_START },
    { name: 'turn_end', payload: CLI_TURN_END },
    { name: 'subagent_start', payload: CLI_SUBAGENT_START },
    { name: 'subagent_end', payload: CLI_SUBAGENT_END },
    { name: 'session_end', payload: CLI_SESSION_END },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLI → API contract: DTO validation', () => {
    it.each(ALL_CLI_EVENTS)(
        '$name payload passes DTO validation',
        async ({ payload }) => {
            const errors = await validate(toDto(payload));
            expect(errors).toHaveLength(0);
        },
    );
});

describe('CLI → API contract: event types match', () => {
    it('CLI event types are a subset of SESSION_EVENT_TYPES', () => {
        const cliTypes = ALL_CLI_EVENTS.map((e) => e.name);
        for (const type of cliTypes) {
            expect(SESSION_EVENT_TYPES).toContain(type);
        }
    });

    it('SESSION_EVENT_TYPES are covered by CLI events', () => {
        const cliTypes = new Set(ALL_CLI_EVENTS.map((e) => e.name));
        for (const type of SESSION_EVENT_TYPES) {
            expect(cliTypes.has(type)).toBe(true);
        }
    });
});

describe('CLI → API contract: envelope/payload split', () => {
    it('session_start — agentType, gitRemote, baseCommit, cliVersion go to payload', () => {
        const { envelope, payload } = splitEnvelope(CLI_SESSION_START);

        expect(envelope).toEqual({
            sessionId: 'sess-abc123',
            type: 'session_start',
            branch: 'feat/auth',
            timestamp: '2025-06-01T10:30:00.000Z',
        });
        expect(payload).toHaveProperty('agentType', 'claude-code');
        expect(payload).toHaveProperty('gitRemote');
        expect(payload).toHaveProperty('baseCommit');
        expect(payload).toHaveProperty('cliVersion');
    });

    it('turn_start — turnId, prompt, commitBefore go to payload', () => {
        const { payload } = splitEnvelope(CLI_TURN_START);

        expect(payload).toHaveProperty('turnId');
        expect(payload).toHaveProperty('prompt', 'Fix the authentication bug');
        expect(payload).toHaveProperty('commitBefore');
    });

    it('turn_end — toolCalls, filesModified, tokenUsage go to payload', () => {
        const { payload } = splitEnvelope(CLI_TURN_END);

        expect(payload).toHaveProperty('turnId');
        expect(payload).toHaveProperty('toolCalls');
        expect(payload).toHaveProperty('filesModified');
        expect(payload).toHaveProperty('filesRead');
        expect(payload).toHaveProperty('commands');
        expect(payload).toHaveProperty('tokenUsage');
        expect(payload).toHaveProperty('commitAfter');

        // Ensure nested structures survive
        expect((payload as any).toolCalls[0]).toEqual(
            expect.objectContaining({
                toolName: 'Read',
                toolUseId: 'tool-1',
                isMcp: false,
            }),
        );
        expect((payload as any).tokenUsage).toEqual(
            expect.objectContaining({
                inputTokens: 1200,
                outputTokens: 300,
            }),
        );
    });

    it('subagent_start — toolUseId, subagentType, taskDescription go to payload', () => {
        const { payload } = splitEnvelope(CLI_SUBAGENT_START);

        expect(payload).toHaveProperty('toolUseId', 'tool-2');
        expect(payload).toHaveProperty('subagentType', 'Explore');
        expect(payload).toHaveProperty(
            'taskDescription',
            'Find all authentication controllers',
        );
    });

    it('subagent_end — toolUseId goes to payload', () => {
        const { payload } = splitEnvelope(CLI_SUBAGENT_END);
        expect(payload).toEqual({ toolUseId: 'tool-2' });
    });

    it('session_end — payload is empty', () => {
        const { payload } = splitEnvelope(CLI_SESSION_END);
        expect(payload).toEqual({});
    });
});

describe('CLI → API contract: timestamp format', () => {
    it.each(ALL_CLI_EVENTS)(
        '$name timestamp is a valid ISO 8601 string',
        ({ payload }) => {
            const date = new Date(payload.timestamp);
            expect(date.toISOString()).toBe(payload.timestamp);
        },
    );
});

describe('CLI → API contract: sessionId consistency', () => {
    it('all events in a session share the same sessionId', () => {
        const ids = ALL_CLI_EVENTS.map((e) => e.payload.sessionId);
        expect(new Set(ids).size).toBe(1);
    });
});
