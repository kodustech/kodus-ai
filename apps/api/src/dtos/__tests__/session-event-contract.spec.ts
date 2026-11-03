/**
 * Contract tests — validate that the payloads the CLI actually sends
 * pass DTO validation.
 *
 * If these tests break, the CLI and API are out of sync.
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SessionEventRequestDto } from '../session-event.dto';

function toDto(plain: Record<string, unknown>): SessionEventRequestDto {
    return plainToInstance(SessionEventRequestDto, plain);
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
