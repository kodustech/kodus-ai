import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionApiEvent } from '../../../types/session-events.js';

const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const appendFileMock = vi.fn();
const mkdirMock = vi.fn();
const unlinkMock = vi.fn();

vi.mock('fs/promises', () => ({
    default: {
        readFile: readFileMock,
        writeFile: writeFileMock,
        appendFile: appendFileMock,
        mkdir: mkdirMock,
        unlink: unlinkMock,
    },
}));

const requestMock = vi.fn();
vi.mock('../api.real.js', () => ({
    request: requestMock,
}));

const getValidTokenMock = vi.fn();
vi.mock('../../auth.service.js', () => ({
    authService: {
        getValidToken: getValidTokenMock,
    },
}));

describe('RealSessionsApi', () => {
    beforeEach(() => {
        vi.resetModules();
        readFileMock.mockReset();
        writeFileMock.mockReset();
        appendFileMock.mockReset();
        mkdirMock.mockReset();
        unlinkMock.mockReset();
        requestMock.mockReset();
        getValidTokenMock.mockReset();

        readFileMock.mockRejectedValue(
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
        );
        mkdirMock.mockResolvedValue(undefined);
        appendFileMock.mockResolvedValue(undefined);
        writeFileMock.mockResolvedValue(undefined);
        unlinkMock.mockResolvedValue(undefined);
        getValidTokenMock.mockResolvedValue('token');
        requestMock.mockRejectedValue(new Error('network down'));
    });

    it('buffers failed events with appendFile', async () => {
        const { RealSessionsApi } = await import('../sessions.api.js');
        const api = new RealSessionsApi();
        const repoRoot = '/tmp/repo';

        const event: SessionApiEvent = {
            type: 'session_start',
            sessionId: 'session-1',
            branch: 'main',
            timestamp: new Date().toISOString(),
            agentType: 'codex',
            gitRemote: 'origin',
            baseCommit: 'abc123',
            cliVersion: '0.0.0-test',
        };

        await api.sendEvent(event, repoRoot);

        expect(appendFileMock).toHaveBeenCalledTimes(1);
        expect(writeFileMock).not.toHaveBeenCalledWith(
            expect.stringContaining('pending-events.jsonl'),
            expect.any(String),
            'utf-8',
        );
    });
});
