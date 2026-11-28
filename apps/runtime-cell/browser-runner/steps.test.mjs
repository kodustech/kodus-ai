// node --test apps/runtime-cell/browser-runner/ (no browser: a fake page).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkJob, JobError, playSteps } from './steps.mjs';
import { tarEntry, TAR_END } from './tar.mjs';

const job = (steps) => ({ steps, viewport: { width: 1280, height: 720 }, origin: 'http://app.kody.internal:3000', timeoutMs: 30_000 });

test('the job is the closed list: anything else is refused', () => {
    assert.ok(checkJob(job([{ goto: '/' }, { screenshot: 'home' }])));
    for (const bad of [[{ evaluate: 'document.cookie' }], [{ goto: '/', click: '#a' }], [{ goto: '//evil.example/' }], [{ goto: '/.git/config' }], [{ goto: '/.env.local' }], [{ press: 'Enter; rm' }], [{ fill: ['#a'] }], []]) {
        assert.throws(() => checkJob(job(bad)), JobError, JSON.stringify(bad));
    }
    assert.throws(() => checkJob({ ...job([{ goto: '/' }]), origin: 'https://app.kody.internal:3000/x' }), JobError);
    assert.throws(() => checkJob({ ...job([{ goto: '/' }]), timeoutMs: 120_000 }), JobError);
});

function fakePage(texts) {
    const calls = [];
    const locator = (sel) => ({
        first: () => ({
            click: async () => calls.push(['click', sel]),
            fill: async (v) => calls.push(['fill', sel, v]),
            selectOption: async (v) => calls.push(['select', sel, v]),
            waitFor: async ({ state }) => {
                if (!(sel in texts)) throw Object.assign(new Error('Timeout 5000ms exceeded'), { name: 'TimeoutError' });
                calls.push(['waitFor', sel, state]);
            },
            innerText: async () => texts[sel],
            getAttribute: async (name) => (name === 'type' ? 'submit' : null),
        }),
    });
    return { calls, page: { locator, goto: async (u) => calls.push(['goto', u]), keyboard: { press: async (k) => calls.push(['press', k]) } } };
}

test('plays every step on locators, never page script, and stops at the first failure with its screenshot', async () => {
    let t = 0;
    const { page, calls } = fakePage({ '#orders': '', '#place': 'Submit' });
    const shots = [];
    const out = await playSteps({
        steps: [{ goto: '/' }, { getAttribute: ['#place', 'type'] }, { expectText: ['#orders', 'keyboard'] }, { click: '#place' }],
        origin: 'http://app.kody.internal:3000',
        page,
        shoot: async (name) => (shots.push(name), shots.length - 1),
        now: () => (t += 50),
        deadline: 60_000,
        sleep: async () => {},
    });
    assert.deepEqual(calls[0], ['goto', 'http://app.kody.internal:3000/']);
    assert.equal(out[1].value, 'submit');
    // The empty list is a mismatch with what it read, not a timeout.
    assert.equal(out[2].ok, false);
    assert.equal(out[2].error, 'mismatch');
    assert.equal(out[2].value, '');
    assert.equal(out[2].screenshot, 0);
    assert.deepEqual(shots, ['failed-step-2']);
    assert.deepEqual(out[3], { index: 3, kind: 'click', ok: false, startMs: out[3].startMs, endMs: out[3].startMs, error: 'skipped' });
    assert.ok(!calls.some((c) => c[0] === 'click'));
});

test('an element that never appears is not_found; an internal selector is refused', async () => {
    const { page } = fakePage({});
    let t = 0;
    const out = await playSteps({ steps: [{ waitFor: '#nope' }], origin: 'http://h:1', page, shoot: async () => undefined, now: () => (t += 1), deadline: 60_000 });
    assert.equal(out[0].error, 'not_found');
    const refused = await playSteps({ steps: [{ click: 'internal:role=button' }], origin: 'http://h:1', page, shoot: async () => undefined, now: () => (t += 1), deadline: 60_000 });
    assert.equal(refused[0].error, 'refused');
});

test('the tar stream is ustar with 512-byte blocks', () => {
    const [header, data, pad] = tarEntry('result.json', Buffer.from('{}'));
    assert.equal(header.length, 512);
    assert.equal(header.subarray(257, 262).toString(), 'ustar');
    assert.equal(data.length + pad.length, 512);
    assert.equal(TAR_END.length, 1024);
    assert.throws(() => tarEntry('../x', Buffer.alloc(0)));
});

test('evidence is an explicit lean/full grant and omission preserves full', () => {
    const input = job([{ goto: '/' }]);
    assert.equal(checkJob(input).evidence, 'full');
    assert.equal(checkJob({ ...input, evidence: 'lean' }).evidence, 'lean');
    assert.equal(checkJob({ ...input, evidence: 'full' }).evidence, 'full');
    for (const evidence of ['', 'auto', null, 0, {}, ['lean']]) assert.throws(() => checkJob({ ...input, evidence }), JobError);
});
