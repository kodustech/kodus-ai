import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

/**
 * Creates an in-memory RemoteCommands mock for agent-loop tests.
 * All 4 methods are mocked — including exec.
 * CRITICAL: exec must be present. agent-tools.factory.ts gates checkTypes registration
 * on if (remoteCommands.exec). Omitting exec silently suppresses the checkTypes tool.
 * (RESEARCH.md Pitfall 7)
 */
export function createMockRemoteCommands(
    overrides?: Partial<RemoteCommands>,
): RemoteCommands {
    return {
        grep: jest.fn().mockResolvedValue(''),
        read: jest.fn().mockResolvedValue(''),
        listDir: jest.fn().mockResolvedValue(''),
        exec: jest.fn().mockResolvedValue({ stdout: '', exitCode: 0 }),
        ...overrides,
    };
}
