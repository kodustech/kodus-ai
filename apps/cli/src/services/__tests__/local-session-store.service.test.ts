import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
    SESSION_PRUNE,
    forgetDecision,
    listSessionRecords,
    loadSessionRecord,
    pinDecision,
    pruneOldSessions,
    saveSessionRecord,
    upsertTurn,
    type LocalSessionRecord,
} from '../local-session-store.service.js';

describe('local-session-store.service', () => {
    let repoRoot: string;
    let kodusHome: string;
    let prev: string | undefined;

    beforeEach(async () => {
        repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-'));
        kodusHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-home-'));
        prev = process.env.KODUS_HOME;
        process.env.KODUS_HOME = kodusHome;
    });

    afterEach(async () => {
        if (prev === undefined) {
            delete process.env.KODUS_HOME;
        } else {
            process.env.KODUS_HOME = prev;
        }
        await fs.rm(repoRoot, { recursive: true, force: true });
        await fs.rm(kodusHome, { recursive: true, force: true });
    });

    it('writes sessions under KODUS_HOME, never inside the repo', async () => {
        await upsertTurn(repoRoot, 'sess-1', {
            worktreeRoot: repoRoot,
            agentType: 'claude-code',
            branch: 'main',
            turn: {
                turnId: 't1',
                prompt: 'hello',
                response: 'world',
                toolCalls: [],
                filesModified: ['src/a.ts'],
                filesRead: [],
                commands: [],
                timestamp: new Date().toISOString(),
            },
        });

        const records = await listSessionRecords(repoRoot);
        expect(records).toHaveLength(1);
        expect(records[0].sessionId).toBe('sess-1');

        // Repo tree has no .kody/sessions or similar
        const repoEntries = await fs.readdir(repoRoot);
        expect(repoEntries).not.toContain('.kody');
        expect(repoEntries).not.toContain('.kodus');

        // Store is under kodus home
        const underHome = await fs.readdir(path.join(kodusHome, 'sessions'));
        expect(underHome.length).toBeGreaterThan(0);
    });

    it('prunes sessions older than 90 days and keeps 89-day ones', async () => {
        const old: LocalSessionRecord = {
            sessionId: 'old',
            worktreeRoot: repoRoot,
            startedAt: new Date(
                Date.now() - SESSION_PRUNE.RETENTION_MS - 1000,
            ).toISOString(),
            turns: [],
            decisions: [],
            filesTouched: [],
            lastCaptureAt: new Date(
                Date.now() - SESSION_PRUNE.RETENTION_MS - 1000,
            ).toISOString(),
        };
        const keep: LocalSessionRecord = {
            sessionId: 'keep',
            worktreeRoot: repoRoot,
            startedAt: new Date(
                Date.now() - SESSION_PRUNE.KEEP_THRESHOLD_MS,
            ).toISOString(),
            turns: [],
            decisions: [],
            filesTouched: [],
            lastCaptureAt: new Date(
                Date.now() - SESSION_PRUNE.KEEP_THRESHOLD_MS,
            ).toISOString(),
        };
        await saveSessionRecord(repoRoot, old);
        await saveSessionRecord(repoRoot, keep);

        // Force mtimes
        const { getSessionsDir } = await import('../kodus-paths.service.js');
        const dir = await getSessionsDir(repoRoot);
        const oldPath = path.join(dir, 'old.json');
        const keepPath = path.join(dir, 'keep.json');
        const oldTime = (Date.now() - SESSION_PRUNE.RETENTION_MS - 1000) / 1000;
        const keepTime = (Date.now() - SESSION_PRUNE.KEEP_THRESHOLD_MS) / 1000;
        await fs.utimes(oldPath, oldTime, oldTime);
        await fs.utimes(keepPath, keepTime, keepTime);

        const pruned = await pruneOldSessions(repoRoot);
        expect(pruned).toBe(1);
        expect(await loadSessionRecord(repoRoot, 'old')).toBeNull();
        expect(await loadSessionRecord(repoRoot, 'keep')).not.toBeNull();
    });

    it('forget and pin update decision flags', async () => {
        await saveSessionRecord(repoRoot, {
            sessionId: 's',
            worktreeRoot: repoRoot,
            startedAt: new Date().toISOString(),
            turns: [],
            decisions: [
                {
                    id: 'd1',
                    type: 'tradeoff',
                    decision: 'use redis',
                    source: 'local',
                },
            ],
            filesTouched: ['src/cache.ts'],
            lastCaptureAt: new Date().toISOString(),
        });

        expect(await pinDecision(repoRoot, 'd1')).toBe(true);
        const pinned = await loadSessionRecord(repoRoot, 's');
        expect(pinned!.decisions[0].pinned).toBe(true);

        expect(await forgetDecision(repoRoot, 'd1')).toBe(true);
        const forgotten = await loadSessionRecord(repoRoot, 's');
        expect(forgotten!.decisions[0].forgotten).toBe(true);
    });
});
