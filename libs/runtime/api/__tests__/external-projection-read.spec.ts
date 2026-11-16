import { PgSql } from '@libs/runtime/run/adapters/pg-sql';
import { PgRunProjectionStore } from '@libs/runtime/run/adapters/pg-run-projection.store';

import { ReadOnlyRunProjectionStore } from '../infrastructure/pg-runtime-readers';

/** A runtime_runs row of a finished Run whose probes carry their lanes and step logs. */
const row = {
    run_id: 'run',
    organization_id: 'org',
    team_id: 'team',
    repository_id: 'repo',
    pr_number: 7,
    head_sha: 'a'.repeat(40),
    image_id: 'img',
    state: 'regressions_found',
    finished_at: new Date('2026-11-12T10:00:00.000Z'),
    updated_at: new Date('2026-11-12T10:00:00.000Z'),
    correlation_id: 'corr',
    report: {
        probes: [{ probeId: 'p1', verdict: 'regression', baseStepIds: ['b1'], prStepIds: ['p1'], lanes: { base: { stdout: 'log' } }, steps: ['s'] }],
        exploration: [{ index: 0, stepId: 'e', command: 'cat .env', failed: false }],
    },
};

it('an external verification reads only the proof metadata of a Run, never its logs, steps or exploration', async () => {
    const store = new PgRunProjectionStore({ query: async () => ({ rows: [row] }) });
    const run = await store.get('run', { organizationId: 'org' }, { timeoutMs: 1000, view: 'external_verification' });
    expect(run).toEqual({
        runId: 'run',
        organizationId: 'org',
        teamId: 'team',
        repositoryId: 'repo',
        prNumber: 7,
        headSha: 'a'.repeat(40),
        imageId: 'img',
        state: 'regressions_found',
        finishedAt: '2026-11-12T10:00:00.000Z',
        probes: [{ probeId: 'p1', verdict: 'regression', baseStepIds: ['b1'], prStepIds: ['p1'] }],
    });
});

it('a read whose deadline passes while it waits for a connection fails, and never runs its query afterwards', async () => {
    jest.useFakeTimers();
    let connected!: (client: unknown) => void;
    const sent: string[] = [];
    const client = { query: jest.fn(async (text: string) => sent.push(text)), release: jest.fn() };
    const pool = { connect: () => new Promise((resolve) => (connected = resolve)), query: jest.fn() };
    const reader = new ReadOnlyRunProjectionStore(new PgSql(() => pool as never, { readOnly: true }));
    try {
        const reading = reader.get('run', { organizationId: 'org' }, { timeoutMs: 100 });
        const failed = expect(reading).rejects.toThrow('aborted');
        await jest.advanceTimersByTimeAsync(100);
        await failed;
        connected(client);
        await jest.advanceTimersByTimeAsync(0);
        expect(sent).toEqual([]);
        expect(client.release).toHaveBeenCalled();
    } finally {
        jest.useRealTimers();
    }
});
