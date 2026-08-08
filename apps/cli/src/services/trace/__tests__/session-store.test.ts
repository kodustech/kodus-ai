import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    appendRecordLine,
    lastCaptureAt,
    listSessions,
    parseSessionRecord,
    pruneOldSessions,
    readSessionRecord,
    SESSION_RETENTION_MS,
} from '../session-store.js';
import {
    repoStoreDir,
    sessionRecordPath,
    sessionsRoot,
} from '../store-paths.js';
import { toRepoRelative } from '../../lifecycle.service.js';

let traceHome: string;
let repoA: string;
let repoB: string;

beforeEach(async () => {
    traceHome = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-home-'));
    process.env.KODUS_TRACE_HOME = traceHome;
    repoA = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-a-'));
    repoB = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-b-'));
});

afterEach(async () => {
    delete process.env.KODUS_TRACE_HOME;
    await Promise.all(
        [traceHome, repoA, repoB].map((dir) =>
            fs.rm(dir, { recursive: true, force: true }),
        ),
    );
});

async function writeSession(
    repoRoot: string,
    sessionId: string,
    branch = 'feat/x',
): Promise<void> {
    await appendRecordLine(repoRoot, sessionId, {
        kind: 'session-start',
        sessionId,
        agentType: 'claude-code',
        branch,
        baseCommit: 'abc123',
        gitRemote: 'git@github.com:org/repo.git',
        cliVersion: '9.9.9',
        timestamp: '2026-01-01T00:00:00.000Z',
    });
    await appendRecordLine(repoRoot, sessionId, {
        kind: 'turn-start',
        turnId: 't1',
        prompt: 'make the invoice total idempotent',
        commitBefore: 'abc123',
        timestamp: '2026-01-01T00:00:01.000Z',
    });
    await appendRecordLine(repoRoot, sessionId, {
        kind: 'turn-end',
        turnId: 't1',
        response: 'done',
        toolCalls: [{ toolName: 'Edit', summary: 'src/billing/invoice.ts' }],
        filesModified: [{ path: 'src/billing/invoice.ts', action: 'modified' }],
        filesRead: [],
        commands: [],
        tokenUsage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            apiCallCount: 1,
        },
        commitAfter: 'def456',
        timestamp: '2026-01-01T00:00:02.000Z',
    });
}

describe('local session store', () => {
    it('writes under ~/.kodus/sessions and nowhere near the repository', async () => {
        await writeSession(repoA, 'sess-1');

        expect(sessionRecordPath(repoA, 'sess-1')).toContain(sessionsRoot());
        expect(sessionRecordPath(repoA, 'sess-1').startsWith(repoA)).toBe(
            false,
        );
        await expect(fs.readdir(repoA)).resolves.toEqual([]);
    });

    it('round-trips a session record', async () => {
        await writeSession(repoA, 'sess-1');

        const session = await readSessionRecord(repoA, 'sess-1');
        expect(session).not.toBeNull();
        expect(session!.branch).toBe('feat/x');
        expect(session!.agentType).toBe('claude-code');
        expect(session!.turns).toHaveLength(1);
        expect(session!.turns[0].prompt).toContain('idempotent');
        expect(session!.turns[0].filesModified[0].path).toBe(
            'src/billing/invoice.ts',
        );
        expect(session!.corruptLines).toBe(0);
    });

    it('renders the parts that exist when the record is truncated', async () => {
        await writeSession(repoA, 'sess-1');

        // Simulate a process killed mid-write: a half-flushed final line.
        const filePath = sessionRecordPath(repoA, 'sess-1');
        await fs.appendFile(filePath, '{"kind":"turn-start","turnI');

        const session = await readSessionRecord(repoA, 'sess-1');
        expect(session!.turns).toHaveLength(1);
        expect(session!.corruptLines).toBe(1);
    });

    it('returns null for a session that was never recorded', async () => {
        await expect(readSessionRecord(repoA, 'nope')).resolves.toBeNull();
    });

    it('parses a record with no session-start line', () => {
        const session = parseSessionRecord(
            'orphan',
            `${JSON.stringify({
                kind: 'turn-end',
                turnId: 't9',
                response: 'r',
                toolCalls: [],
                filesModified: [],
                filesRead: [],
                commands: [],
                tokenUsage: {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreationTokens: 0,
                    cacheReadTokens: 0,
                    apiCallCount: 0,
                },
                commitAfter: '',
                timestamp: '2026-01-01T00:00:00.000Z',
            })}\n`,
        );

        expect(session.turns).toHaveLength(1);
        expect(session.branch).toBeUndefined();
    });

    it('keeps two worktrees of the same repository apart', async () => {
        await writeSession(repoA, 'shared-id');
        await writeSession(repoB, 'shared-id', 'feat/y');

        expect(repoStoreDir(repoA)).not.toBe(repoStoreDir(repoB));

        const fromA = await readSessionRecord(repoA, 'shared-id');
        const fromB = await readSessionRecord(repoB, 'shared-id');
        expect(fromA!.branch).toBe('feat/x');
        expect(fromB!.branch).toBe('feat/y');

        expect((await listSessions(repoA)).map((s) => s.sessionId)).toEqual([
            'shared-id',
        ]);
        expect((await listSessions(repoB)).map((s) => s.sessionId)).toEqual([
            'shared-id',
        ]);
    });

    it('summarises sessions for the list view', async () => {
        await writeSession(repoA, 'sess-1');

        const [summary] = await listSessions(repoA);
        expect(summary.turnCount).toBe(1);
        expect(summary.filesTouched).toEqual(['src/billing/invoice.ts']);
        expect(summary.agentType).toBe('claude-code');
    });

    it('reports the last capture time', async () => {
        expect(await lastCaptureAt(repoA)).toBeNull();
        await writeSession(repoA, 'sess-1');
        expect(await lastCaptureAt(repoA)).toMatch(/^\d{4}-/);
    });
});

describe('toRepoRelative', () => {
    it('rewrites an absolute path inside the repository', () => {
        expect(toRepoRelative('/repo', '/repo/src/billing/invoice.ts')).toBe(
            'src/billing/invoice.ts',
        );
    });

    it('leaves a repo-relative path alone', () => {
        expect(toRepoRelative('/repo', 'src/billing/invoice.ts')).toBe(
            'src/billing/invoice.ts',
        );
    });

    it('leaves a path outside the repository alone', () => {
        expect(toRepoRelative('/repo', '/etc/hosts')).toBe('/etc/hosts');
    });

    it('handles empty input', () => {
        expect(toRepoRelative('/repo', '')).toBe('');
    });
});

describe('retention', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    async function ageSession(
        repoRoot: string,
        sessionId: string,
        days: number,
    ): Promise<void> {
        const filePath = sessionRecordPath(repoRoot, sessionId);
        const when = new Date(Date.now() - days * DAY_MS);
        await fs.utimes(filePath, when, when);
    }

    it('prunes a session older than 90 days', async () => {
        await writeSession(repoA, 'old');
        await ageSession(repoA, 'old', 91);

        const pruned = await pruneOldSessions(repoA, SESSION_RETENTION_MS);

        expect(pruned).toEqual(['old']);
        await expect(readSessionRecord(repoA, 'old')).resolves.toBeNull();
    });

    it('keeps a session at 89 days', async () => {
        await writeSession(repoA, 'recent');
        await ageSession(repoA, 'recent', 89);

        const pruned = await pruneOldSessions(repoA, SESSION_RETENTION_MS);

        expect(pruned).toEqual([]);
        await expect(
            readSessionRecord(repoA, 'recent'),
        ).resolves.not.toBeNull();
    });

    it('is a no-op when nothing has been captured', async () => {
        await expect(pruneOldSessions(repoA)).resolves.toEqual([]);
    });
});
