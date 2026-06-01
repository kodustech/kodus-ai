import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
    saveLocal,
    loadLocal,
    removeLocal,
    markTurnCompleted,
    listStaleSessions,
    type LocalSessionData,
} from '../session-local.service.js';

describe('session-local.service', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'session-local-test-'),
        );
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    const sampleData: LocalSessionData = {
        turnId: 'turn-abc-123',
        transcriptPath: '/tmp/transcript.jsonl',
        transcriptOffset: 42,
    };

    describe('saveLocal + loadLocal', () => {
        it('round-trips data through save and load', async () => {
            await saveLocal(tmpDir, 'sess-1', sampleData);
            const loaded = await loadLocal(tmpDir, 'sess-1');
            expect(loaded).toEqual(sampleData);
        });

        it('overwrites existing data on second save', async () => {
            await saveLocal(tmpDir, 'sess-1', sampleData);
            const updated: LocalSessionData = {
                ...sampleData,
                transcriptOffset: 99,
                turnCompleted: true,
            };
            await saveLocal(tmpDir, 'sess-1', updated);
            const loaded = await loadLocal(tmpDir, 'sess-1');
            expect(loaded).toEqual(updated);
        });
    });

    describe('loadLocal with missing file', () => {
        it('returns null when file does not exist', async () => {
            const result = await loadLocal(tmpDir, 'nonexistent');
            expect(result).toBeNull();
        });
    });

    describe('removeLocal', () => {
        it('removes the file so subsequent loadLocal returns null', async () => {
            await saveLocal(tmpDir, 'sess-del', sampleData);
            // Verify it exists first
            expect(await loadLocal(tmpDir, 'sess-del')).not.toBeNull();

            await removeLocal(tmpDir, 'sess-del');
            expect(await loadLocal(tmpDir, 'sess-del')).toBeNull();
        });

        it('does not throw when file does not exist', async () => {
            await expect(
                removeLocal(tmpDir, 'no-such-session'),
            ).resolves.toBeUndefined();
        });
    });

    describe('path traversal protection', () => {
        it('throws for sessionId with path traversal', async () => {
            await expect(
                saveLocal(tmpDir, '../../etc/passwd', sampleData),
            ).rejects.toThrow('Invalid sessionId');
        });

        it('throws for sessionId with subdirectory', async () => {
            await expect(
                saveLocal(tmpDir, 'sub/dir', sampleData),
            ).rejects.toThrow('Invalid sessionId');
        });

        it('throws for sessionId with parent directory prefix', async () => {
            await expect(
                saveLocal(tmpDir, '../escape', sampleData),
            ).rejects.toThrow('Invalid sessionId');
        });
    });

    describe('markTurnCompleted', () => {
        it('sets turnCompleted to true on existing session', async () => {
            await saveLocal(tmpDir, 'sess-mark', sampleData);
            expect(sampleData.turnCompleted).toBeUndefined();

            await markTurnCompleted(tmpDir, 'sess-mark');

            const loaded = await loadLocal(tmpDir, 'sess-mark');
            expect(loaded).not.toBeNull();
            expect(loaded!.turnCompleted).toBe(true);
            // Other fields are preserved
            expect(loaded!.turnId).toBe(sampleData.turnId);
            expect(loaded!.transcriptPath).toBe(sampleData.transcriptPath);
            expect(loaded!.transcriptOffset).toBe(sampleData.transcriptOffset);
        });

        it('does nothing when session does not exist (no crash)', async () => {
            await expect(
                markTurnCompleted(tmpDir, 'ghost-session'),
            ).resolves.toBeUndefined();

            // Still no file created
            expect(await loadLocal(tmpDir, 'ghost-session')).toBeNull();
        });
    });

    describe('listStaleSessions', () => {
        const ONE_HOUR_MS = 60 * 60 * 1000;

        it('finds sessions with old mtime', async () => {
            // Create two session files
            await saveLocal(tmpDir, 'old-sess-1', sampleData);
            await saveLocal(tmpDir, 'old-sess-2', sampleData);

            // Set their mtime to 2 hours ago
            const twoHoursAgo = new Date(Date.now() - 2 * ONE_HOUR_MS);
            const sessDir = path.join(tmpDir, '.kody', 'sessions');
            await fs.utimes(
                path.join(sessDir, 'old-sess-1.json'),
                twoHoursAgo,
                twoHoursAgo,
            );
            await fs.utimes(
                path.join(sessDir, 'old-sess-2.json'),
                twoHoursAgo,
                twoHoursAgo,
            );

            const stale = await listStaleSessions(tmpDir, ONE_HOUR_MS);
            const ids = stale.map((s) => s.sessionId).sort();
            expect(ids).toEqual(['old-sess-1', 'old-sess-2']);
            for (const s of stale) {
                expect(s.ageMs).toBeGreaterThan(ONE_HOUR_MS);
            }
        });

        it('returns empty array when all files are fresh', async () => {
            await saveLocal(tmpDir, 'fresh-sess', sampleData);

            const stale = await listStaleSessions(tmpDir, ONE_HOUR_MS);
            expect(stale).toEqual([]);
        });

        it('returns empty array for empty sessions directory', async () => {
            // Create the directory but no files
            const sessDir = path.join(tmpDir, '.kody', 'sessions');
            await fs.mkdir(sessDir, { recursive: true });

            const stale = await listStaleSessions(tmpDir, ONE_HOUR_MS);
            expect(stale).toEqual([]);
        });

        it('returns empty array when sessions directory does not exist', async () => {
            const stale = await listStaleSessions(tmpDir, ONE_HOUR_MS);
            expect(stale).toEqual([]);
        });

        it('ignores non-json files in the directory', async () => {
            await saveLocal(tmpDir, 'real-sess', sampleData);
            const sessDir = path.join(tmpDir, '.kody', 'sessions');
            await fs.writeFile(
                path.join(sessDir, 'README.txt'),
                'not a session',
            );

            // Make both old
            const old = new Date(Date.now() - 2 * ONE_HOUR_MS);
            await fs.utimes(path.join(sessDir, 'real-sess.json'), old, old);
            await fs.utimes(path.join(sessDir, 'README.txt'), old, old);

            const stale = await listStaleSessions(tmpDir, ONE_HOUR_MS);
            expect(stale).toHaveLength(1);
            expect(stale[0].sessionId).toBe('real-sess');
        });
    });
});
