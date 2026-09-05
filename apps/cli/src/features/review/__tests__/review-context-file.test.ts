import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
    REVIEW_CONTEXT_CONTENT_TYPE,
    REVIEW_CONTEXT_MAX_BYTES,
    REVIEW_CONTEXT_SOURCE,
    loadReviewContextFile,
} from '../review-context-file.js';

const execFile = promisify(execFileCallback);

const temporaryDirectories: string[] = [];

async function createPacket(bytes: Uint8Array): Promise<string> {
    const directory = await mkdtemp(
        path.join(tmpdir(), 'kodus-review-context-'),
    );
    temporaryDirectories.push(directory);
    const packetPath = path.join(directory, 'packet.txt');
    await writeFile(packetPath, bytes);
    return packetPath;
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) =>
                rm(directory, { recursive: true, force: true }),
            ),
    );
});

describe('loadReviewContextFile', () => {
    it('loads a UTF-8 packet into the typed request field without changing the review diff', async () => {
        const packetBody = 'CANARY: inspect abort cleanup π';
        const packetPath = await createPacket(Buffer.from(packetBody, 'utf8'));
        const diff = 'diff --git a/src/a.ts b/src/a.ts\n+const value = 1;';

        const reviewContext = await loadReviewContextFile(packetPath);

        expect(reviewContext).toEqual({
            source: REVIEW_CONTEXT_SOURCE,
            contentType: REVIEW_CONTEXT_CONTENT_TYPE,
            body: packetBody,
        });
        expect(diff).toBe(
            'diff --git a/src/a.ts b/src/a.ts\n+const value = 1;',
        );
        expect(diff).not.toContain(packetBody);
    });

    it('does not change the staged diff when the packet is outside the repository', async () => {
        const repository = await mkdtemp(
            path.join(tmpdir(), 'kodus-review-context-repository-'),
        );
        temporaryDirectories.push(repository);
        await mkdir(path.join(repository, 'src'));
        await execFile('git', ['init'], { cwd: repository });
        await execFile('git', ['config', 'user.email', 'test@kodus.local'], {
            cwd: repository,
        });
        await execFile('git', ['config', 'user.name', 'Kodus Test'], {
            cwd: repository,
        });
        await writeFile(
            path.join(repository, 'src', 'value.ts'),
            'const x = 1;\n',
        );
        await execFile('git', ['add', 'src/value.ts'], { cwd: repository });
        const before = await execFile('git', ['diff', '--cached', '--binary'], {
            cwd: repository,
        });
        const packetPath = await createPacket(
            Buffer.from('CANARY outside repository', 'utf8'),
        );

        await loadReviewContextFile(packetPath);

        const after = await execFile('git', ['diff', '--cached', '--binary'], {
            cwd: repository,
        });
        expect(after.stdout).toBe(before.stdout);
        expect(after.stdout).not.toContain('CANARY outside repository');
    });

    it('accepts a packet at the 12 KiB UTF-8 byte boundary', async () => {
        const packetPath = await createPacket(
            Buffer.from('x'.repeat(REVIEW_CONTEXT_MAX_BYTES), 'utf8'),
        );

        const reviewContext = await loadReviewContextFile(packetPath);

        expect(Buffer.byteLength(reviewContext.body, 'utf8')).toBe(
            REVIEW_CONTEXT_MAX_BYTES,
        );
    });

    it.each([
        {
            name: 'empty',
            bytes: Buffer.alloc(0),
            message: 'must not be empty',
        },
        {
            name: 'NUL-containing',
            bytes: Buffer.from([0x61, 0x00, 0x62]),
            message: 'must not contain NUL bytes',
        },
        {
            name: 'invalid UTF-8',
            bytes: Buffer.from([0xc3, 0x28]),
            message: 'must contain valid UTF-8',
        },
        {
            name: 'oversized',
            bytes: Buffer.alloc(REVIEW_CONTEXT_MAX_BYTES + 1, 0x61),
            message: 'exceeds the 12 KiB limit',
        },
    ])('rejects $name input', async ({ bytes, message }) => {
        const packetPath = await createPacket(bytes);

        await expect(loadReviewContextFile(packetPath)).rejects.toThrow(
            message,
        );
    });

    it('rejects a missing packet before submission', async () => {
        const missingPath = path.join(
            tmpdir(),
            `kodus-missing-context-${process.pid}-${Date.now()}.txt`,
        );

        await expect(loadReviewContextFile(missingPath)).rejects.toThrow(
            'Unable to read review context file',
        );
    });

    it('rejects an unreadable packet path before submission', async () => {
        const directory = await mkdtemp(
            path.join(tmpdir(), 'kodus-review-context-directory-'),
        );
        temporaryDirectories.push(directory);

        await expect(loadReviewContextFile(directory)).rejects.toThrow(
            'Unable to read review context file',
        );
    });
});
