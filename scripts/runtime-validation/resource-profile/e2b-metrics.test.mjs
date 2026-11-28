import assert from 'node:assert/strict';
import test from 'node:test';

import { collectMetrics, main, parseOptions } from './e2b-metrics.mjs';

const start = new Date('2026-11-07T12:00:00Z');
const end = new Date('2026-11-07T12:05:00Z');

test('uses only explicit bounded metrics calls and filters all unknown fields', async () => {
    const calls = [];
    const rows = await collectMetrics(async (id, options) => {
        calls.push([id, options]);
        return [{ timestamp: start, cpuUsedPct: 175, cpuCount: 2, memUsed: 1024, memTotal: 2048,
            memCache: 512, diskUsed: 4096, diskTotal: 8192, secret: 'SECRET', labels: { token: 'SECRET' } }];
    }, { ids: ['sandbox-1'], start, end, apiKey: 'SECRET' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'sandbox-1');
    assert.equal(calls[0][1].apiKey, 'SECRET');
    assert.equal(calls[0][1].start, start);
    assert.equal(calls[0][1].end, end);
    assert.equal(rows[0].metrics[0].cpuUsedPct, 175);
    assert.equal(rows[0].metrics[0].cpuCount, 2);
    assert.equal(JSON.stringify(rows).includes('SECRET'), false);
    assert.equal('cpuCores' in rows[0].metrics[0], false);
});

test('one failed sandbox cannot expose error text or suppress the other', async () => {
    const rows = await collectMetrics(async (id) => {
        if (id === 'bad') throw new Error('SECRET upstream response');
        return [{ timestamp: start, cpuUsedPct: 50, cpuCount: 1, unknown: 'SECRET' }];
    }, { ids: ['bad', 'good'], start, end, apiKey: 'SECRET' });
    assert.deepEqual(rows[0], { sandboxId: 'bad', error: { code: 'metrics_unavailable' } });
    assert.equal(rows[1].metrics[0].cpuUsedPct, 50);
    assert.equal(JSON.stringify(rows).includes('SECRET'), false);
});

test('refuses more than two targets and unbounded or invalid windows', () => {
    const argv = ['--sandbox', 'one', '--start', start.toISOString(), '--end', end.toISOString()];
    assert.equal(parseOptions(argv).ids[0], 'one');
    for (const extra of [['--sandbox', 'two', '--sandbox', 'three'], ['--end', 'invalid']]) {
        assert.throws(() => parseOptions([...argv, ...extra]));
    }
    assert.throws(() => parseOptions(['--sandbox', 'one', '--start', start.toISOString(), '--end', '2026-11-08T12:00:00Z']));
});

test('omits nonnumeric metrics and samples outside the explicit time window', async () => {
    const rows = await collectMetrics(async () => [
        { timestamp: 'invalid SECRET', cpuUsedPct: 100 },
        { timestamp: new Date('2026-11-07T11:59:59Z'), cpuUsedPct: 100 },
        { timestamp: start, cpuUsedPct: NaN, cpuCount: true, memUsed: 'SECRET', memTotal: Infinity, diskUsed: -1, memCache: 0 },
    ], { ids: ['one'], start, end, apiKey: 'SECRET' });
    assert.deepEqual(rows[0].metrics, [{ timestamp: start.toISOString(), memCache: 0 }]);
    assert.equal(JSON.stringify(rows).includes('SECRET'), false);
});

async function runCli(getMetrics, ids = ['one']) {
    let output = '';
    let errors = '';
    const code = await main([
        ...ids.flatMap((id) => ['--sandbox', id]),
        '--start', start.toISOString(), '--end', end.toISOString(),
    ], {
        getMetrics,
        env: { E2B_API_KEY: 'SECRET' },
        stdout: { write: (text) => { output += text; } },
        stderr: { write: (text) => { errors += text; } },
    });
    assert.equal(`${output}${errors}`.includes('SECRET'), false);
    return { code, rows: JSON.parse(output).samples };
}

test('CLI returns failure for unavailable, empty, or timestamp-only histories while preserving output', async () => {
    for (const getMetrics of [
        async () => { throw new Error('SECRET upstream response'); },
        async () => [],
        async () => [{ timestamp: new Date('2026-11-07T11:59:59Z'), memUsed: 42 }],
        async () => [{ timestamp: start, unknown: 'SECRET', cpuUsedPct: NaN }],
    ]) {
        const { code, rows } = await runCli(getMetrics);
        assert.notEqual(code, 0);
        assert.equal(rows.length, 1);
        assert.equal(Boolean(rows[0].error) || rows[0].metrics.length === 0, true);
    }
});

test('CLI accepts partial measurements and legitimate zero numeric metrics', async () => {
    const { code, rows } = await runCli(async (id) => {
        if (id === 'bad') throw new Error('SECRET upstream response');
        return [{ timestamp: start, memUsed: 0 }];
    }, ['bad', 'good']);
    assert.equal(code, 0);
    assert.equal(rows[0].error.code, 'metrics_unavailable');
    assert.deepEqual(rows[1].metrics, [{ timestamp: start.toISOString(), memUsed: 0 }]);
});
