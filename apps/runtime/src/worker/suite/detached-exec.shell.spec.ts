import { execFile } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { EnvError, ExecRequest, StepResult } from '@libs/runtime/environment';

import { runDetached } from './detached-exec';

// The wrapper the poller starts and reads is a POSIX shell script: run for real, in a temporary directory, with a
// small command that writes a result file and exits.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function shellEnv(root: string) {
    return {
        async exec(_claimId: string, req: ExecRequest): Promise<StepResult | EnvError> {
            return new Promise((resolve) => {
                const start = Date.now();
                execFile('sh', ['-c', req.command], { cwd: root, timeout: req.timeoutMs }, (err, stdout, stderr) => {
                    resolve({ stepId: req.stepId, exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr, truncated: false, durationMs: Date.now() - start, transport: 'ok' });
                });
            });
        },
    };
}

describe('the detached wrapper in a real shell', () => {
    let root: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'kodus-suite-'));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    const go = (command: string, over: Partial<Parameters<typeof runDetached>[0]> = {}) =>
        runDetached({ env: shellEnv(root), claimId: 'c', key: 'sr-1-0', command, resultsGlob: 'results/*.xml', timeoutMs: 20_000, pollMs: 100, now: Date.now, sleep, stateDir: join(root, 'state'), ...over });

    it('runs the command once, in the working directory, and reads its exit status and result files', async () => {
        const r = await go('mkdir -p results && sleep 1 && echo "<x/>" > results/a.xml && echo run >> ran.txt; exit 0', { cwd: '.' });
        expect(r).toMatchObject({ outcome: 'finished', exitCode: 0, resultFiles: ['results/a.xml'] });
    });

    it('a second start with the same key does not run the command again', async () => {
        const command = 'mkdir -p results && echo "<x/>" > results/a.xml && echo run >> ran.txt';
        await go(command);
        await go(command);
        const ran = readFileSync(join(root, 'ran.txt'), 'utf8').trim().split('\n');
        expect(ran).toEqual(['run']);
    });

    it('a failing command that wrote results is finished with its status; one that wrote none is infra', async () => {
        expect(await go('mkdir -p results && echo "<x/>" > results/a.xml; exit 2')).toMatchObject({ outcome: 'finished', exitCode: 2 });
        rmSync(join(root, 'results'), { recursive: true, force: true });
        expect(await go('exit 1', { key: 'sr-1-1' })).toMatchObject({ outcome: 'infra', reason: 'no_result_file', exitCode: 1 });
    });

    it('stops a command that outlives its timeout', async () => {
        const r = await go('sleep 30', { key: 'sr-1-2', timeoutMs: 1_500 });
        expect(r.outcome).toBe('timeout');
    });

    it('a cancel stops the command and the child it started, leaving no process behind', async () => {
        const stop = new AbortController();
        const marker = join(root, 'child-alive');
        // The child writes a heartbeat; after the cancel it must stop writing.
        const command = `mkdir -p results; (while true; do date +%s%N > '${marker}'; sleep 0.1; done) & wait`;
        const r = await go(command, { key: 'sr-1-3', signal: stop.signal, onPoll: async () => void stop.abort() });
        expect(r.outcome).toBe('cancelled');
        await sleep(400);
        const before = readFileSync(marker, 'utf8');
        await sleep(400);
        expect(readFileSync(marker, 'utf8')).toBe(before);
    });
});
