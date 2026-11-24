import { execFile } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { EnvError, ExecRequest, StepResult } from '@libs/runtime/environment';

import { ExecArtifactSource, READ_CHUNK_BYTES } from './suite-artifacts';

// The host side of the artifact keeper in a real shell: `find`, `wc` and `od` over real files, binary bytes included, across
// more than one read chunk.

function shellEnv(root: string) {
    return {
        async exec(_claimId: string, req: ExecRequest): Promise<StepResult | EnvError> {
            return new Promise((resolve) => {
                const start = Date.now();
                execFile('sh', ['-c', req.command], { cwd: req.cwd ? join(root, req.cwd) : root, timeout: req.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
                    resolve({ stepId: req.stepId, exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr, truncated: false, durationMs: Date.now() - start, transport: 'ok' });
                });
            });
        },
    };
}

describe('reading artifacts off a host in a real shell', () => {
    let root: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'kodus-art-'));
        mkdirSync(join(root, 'app/cypress/screenshots/spec a'), { recursive: true });
        mkdirSync(join(root, 'app/cypress/videos'), { recursive: true });
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('lists the files of the artifact directories with their sizes, paths with a space included, and skips a directory that is not there', async () => {
        writeFileSync(join(root, 'app/cypress/screenshots/spec a/fail.png'), Buffer.alloc(10, 1));
        writeFileSync(join(root, 'app/cypress/videos/run.webm'), Buffer.alloc(300, 2));
        const files = await new ExecArtifactSource(shellEnv(root), 'k').list('c', { cwd: 'app', dirs: ['cypress/screenshots', 'cypress/videos', 'cypress/missing'] });
        expect(files?.sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
            { path: 'cypress/screenshots/spec a/fail.png', bytes: 10 },
            { path: 'cypress/videos/run.webm', bytes: 300 },
        ]);
    });

    it('reads a binary file byte for byte, across several chunks, and refuses a path that leaves the directory', async () => {
        const body = Buffer.from(Array.from({ length: READ_CHUNK_BYTES * 2 + 123 }, (_, i) => (i * 7 + 3) % 256));
        writeFileSync(join(root, 'app/cypress/videos/run.webm'), body);
        const source = new ExecArtifactSource(shellEnv(root), 'k');
        const read = await source.read('c', 'cypress/videos/run.webm', { cwd: 'app', bytes: body.length });
        expect(read?.equals(body)).toBe(true);
        expect(await source.read('c', '../outside', { cwd: 'app', bytes: 1 })).toBeUndefined();
    });

    it('a file that shrank since it was listed is no read at all, not a short one', async () => {
        writeFileSync(join(root, 'app/cypress/videos/run.webm'), Buffer.alloc(10, 9));
        expect(await new ExecArtifactSource(shellEnv(root), 'k').read('c', 'cypress/videos/run.webm', { cwd: 'app', bytes: 50 })).toBeUndefined();
    });
});
