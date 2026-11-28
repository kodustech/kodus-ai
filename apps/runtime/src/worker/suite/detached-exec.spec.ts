import { POLL_TIMEOUT_MS, runDetached, safeResultsGlob } from './detached-exec';
import { FakeSuiteEnvironment, SuiteClock } from './testing';

// docs/runtime/e2e-suites.md section 4: exec caps timeoutMs at 600 s and a call returns 192 KiB, so a 10 to 25 minute
// command is started once, detached, and polled by short calls; a runner that crashed without a result file is infra.

const MIN = 60_000;
const key = 'sr-1-0';

function world(run: ConstructorParameters<typeof FakeSuiteEnvironment>[1], over: Partial<Parameters<typeof runDetached>[0]> = {}) {
    const clock = new SuiteClock();
    const env = new FakeSuiteEnvironment(clock, run);
    const seen: string[][] = [];
    const go = () =>
        runDetached({
            env,
            claimId: 'claim-1',
            key,
            command: 'npx cypress run --spec "a.cy.ts,b.cy.ts"',
            cwd: 'apps/dashboard',
            resultsGlob: 'results/*.xml',
            timeoutMs: 40 * MIN,
            now: clock.now,
            sleep: clock.sleep,
            onPoll: (p) => void seen.push(p.resultFiles),
            ...over,
        });
    return { clock, env, seen, go };
}

describe('a suite command run detached', () => {
    it('a 25 minute command is started once and polled in calls that are each under 600 s', async () => {
        const w = world({ runMs: 25 * MIN, exitCode: 0, resultsAt: { 'results/a.xml': 10 * MIN, 'results/b.xml': 24 * MIN } });
        const r = await w.go();
        expect(r).toMatchObject({ outcome: 'finished', exitCode: 0, resultFiles: ['results/a.xml', 'results/b.xml'] });
        expect(w.env.commandRuns).toBe(1);
        expect(w.env.calls.filter((c) => c.kind === 'start')).toHaveLength(1);
        expect(w.env.calls.length).toBeGreaterThan(20);
        expect(Math.max(...w.env.calls.map((c) => c.timeoutMs))).toBeLessThan(600_000);
        expect(POLL_TIMEOUT_MS).toBeLessThan(600_000);
        // Elapsed time is the command's, plus at most one poll interval.
        expect(w.clock.now() - Date.parse('2026-11-23T12:00:00Z')).toBeLessThan(25 * MIN + 60_000);
    });

    it('hands each poll the result files seen so far, so specs are read as they finish', async () => {
        const w = world({ runMs: 5 * MIN, resultsAt: { 'results/a.xml': 1 * MIN, 'results/b.xml': 3 * MIN } });
        await w.go();
        expect(w.seen[0]).toEqual([]);
        expect(w.seen.some((files) => files.length === 1 && files[0] === 'results/a.xml')).toBe(true);
        expect(w.seen[w.seen.length - 1]).toEqual(['results/a.xml', 'results/b.xml']);
    });

    it('a failing exit status with result files is a finished run: red specs are results, not a crash', async () => {
        const w = world({ runMs: 2 * MIN, exitCode: 3, resultsAt: { 'results/a.xml': 1 * MIN } });
        expect(await w.go()).toMatchObject({ outcome: 'finished', exitCode: 3, resultFiles: ['results/a.xml'] });
    });

    it('a runner that died with no result file is infra, never a regression', async () => {
        const w = world({ runMs: 25 * MIN, diesAtMs: 4 * MIN });
        expect(await w.go()).toMatchObject({ outcome: 'infra', reason: 'no_result_file' });
    });

    it('a process that exits with no result file at all is infra too, and says its exit status', async () => {
        const w = world({ runMs: 1 * MIN, exitCode: 1 });
        expect(await w.go()).toMatchObject({ outcome: 'infra', reason: 'no_result_file', exitCode: 1 });
    });

    it('a runner that died after writing some results is a crash that keeps them, for the engine to re-run the rest once', async () => {
        const w = world({ runMs: 25 * MIN, diesAtMs: 12 * MIN, resultsAt: { 'results/a.xml': 5 * MIN } });
        expect(await w.go()).toMatchObject({ outcome: 'crashed', resultFiles: ['results/a.xml'] });
    });

    it('past the shard timeout it stops the command and names what finished', async () => {
        const w = world({ runMs: 90 * MIN, resultsAt: { 'results/a.xml': 5 * MIN } }, { timeoutMs: 25 * MIN });
        const r = await w.go();
        expect(r).toMatchObject({ outcome: 'timeout', resultFiles: ['results/a.xml'] });
        expect(w.env.calls.some((c) => c.kind === 'kill')).toBe(true);
        expect(w.clock.now() - Date.parse('2026-11-23T12:00:00Z')).toBeLessThanOrEqual(25 * MIN + 60_000);
    });

    it('a cancel stops the command and its children, names what finished, and goes no further than the poll that saw it', async () => {
        const stop = new AbortController();
        const w = world({ runMs: 90 * MIN, resultsAt: { 'results/a.xml': 2 * MIN } }, { signal: stop.signal, onPoll: (p) => void (p.resultFiles.length > 0 && stop.abort()) });
        const r = await w.go();
        expect(r).toMatchObject({ outcome: 'cancelled', resultFiles: ['results/a.xml'] });
        expect(w.env.calls.some((c) => c.kind === 'kill')).toBe(true);
        // The kill is the tree's, as the timeout's: the process and everything it started.
        expect(w.env.calls.find((c) => c.kind === 'kill')?.command).toContain('killtree');
        expect(w.clock.now() - Date.parse('2026-11-23T12:00:00Z')).toBeLessThanOrEqual(3 * MIN);
    });

    it('a cancel before the command starts runs nothing', async () => {
        const stop = new AbortController();
        stop.abort();
        const w = world({ runMs: MIN }, { signal: stop.signal });
        expect(await w.go()).toMatchObject({ outcome: 'cancelled', resultFiles: [] });
        expect(w.env.commandRuns).toBe(0);
    });

    it('a poll the transport lost is asked again; three in a row end it as infra', async () => {
        const w = world({ runMs: 3 * MIN, resultsAt: { 'results/a.xml': 1 * MIN }, lostPolls: [2, 3] });
        expect(await w.go()).toMatchObject({ outcome: 'finished' });
        const lost = world({ runMs: 30 * MIN, lostPolls: [2, 3, 4] });
        expect(await lost.go()).toMatchObject({ outcome: 'infra', reason: 'transport_lost' });
    });

    it('a start that did not go through is infra before any polling', async () => {
        const clock = new SuiteClock();
        const env = { exec: async () => ({ code: 'cell_unavailable' as const, cellId: 'c' }) };
        const r = await runDetached({ env, claimId: 'c', key, command: 'true', resultsGlob: 'r/*.xml', timeoutMs: MIN, now: clock.now, sleep: clock.sleep });
        expect(r).toMatchObject({ outcome: 'infra', reason: 'start_failed' });
    });

    it('refuses a results glob whose dot-wildcard segments would expand to a parent directory', async () => {
        for (const resultsGlob of ['.?/.?/etc/*.xml', 'r/.*/x.xml', '../x.xml', '/etc/*.xml']) {
            const w = world({ runMs: MIN }, { resultsGlob });
            expect(await w.go()).toMatchObject({ outcome: 'infra', reason: 'bad_results_glob' });
        }
        expect(['results/*.xml', 'cypress/results/**/*.xml', 'r/.reports/x.xml'].every(safeResultsGlob)).toBe(true);
    });

    it('refuses a results glob that is more than a path pattern, before running anything', async () => {
        const w = world({ runMs: MIN }, { resultsGlob: 'r/*.xml; rm -rf /' });
        expect(await w.go()).toMatchObject({ outcome: 'infra', reason: 'bad_results_glob' });
        expect(w.env.calls).toEqual([]);
    });

    describe('in a compose service (suite.service)', () => {
        it('the start, every poll, the kill and the final read all run in that service', async () => {
            const w = world({ runMs: 60 * MIN }, { service: 'e2e', timeoutMs: 2 * MIN });
            expect(await w.go()).toMatchObject({ outcome: 'timeout' });
            const kinds = new Set(w.env.calls.map((c) => c.kind));
            expect([...kinds].sort()).toEqual(['kill', 'poll', 'start']);
            expect(w.env.calls.every((c) => c.service === 'e2e')).toBe(true);
        });

        it('without a service no call names one: the public service runs it, as before', async () => {
            const w = world({ runMs: 2 * MIN, resultsAt: { 'results/a.xml': 1 * MIN } });
            await w.go();
            expect(w.env.calls.length).toBeGreaterThan(1);
            expect(w.env.calls.some((c) => 'service' in c)).toBe(false);
        });

        it('the suite cwd is a path under the service container\'s own workdir: the scripts cd into it, the exec carries no absolute cwd', async () => {
            const w = world({ runMs: 2 * MIN, resultsAt: { 'results/a.xml': 1 * MIN } }, { service: 'e2e', cwd: 'apps/dashboard' });
            await w.go();
            const start = w.env.calls.find((c) => c.kind === 'start')!;
            expect(start.command).toContain(`sh -c 'cd "$1" && sh "$2"; echo $? > "$3/exit"' sh 'apps/dashboard'`);
            expect(w.env.calls.filter((c) => c.kind === 'poll').every((c) => c.command.includes("cd 'apps/dashboard'"))).toBe(true);
            expect(w.env.calls.every((c) => c.service === 'e2e')).toBe(true);
        });

        it('a cwd that leaves the container workdir is refused before any call', async () => {
            const w = world({ runMs: 2 * MIN }, { service: 'e2e', cwd: '../elsewhere' });
            expect(await w.go()).toMatchObject({ outcome: 'infra', reason: 'bad_input' });
            expect(w.env.calls).toHaveLength(0);
        });

        it('a cell that cannot run in a service is infra with its own reason, and nothing is polled', async () => {
            const w = world({ runMs: 2 * MIN, refusesService: true }, { service: 'e2e' });
            expect(await w.go()).toMatchObject({ outcome: 'infra', reason: 'service_unsupported' });
            expect(w.env.calls).toHaveLength(1);
        });

        it('refuses a service name that is not a compose service name', async () => {
            const w = world({ runMs: 2 * MIN }, { service: '../e2e' });
            expect(await w.go()).toMatchObject({ outcome: 'infra', reason: 'bad_input' });
            expect(w.env.calls).toHaveLength(0);
        });
    });
});
