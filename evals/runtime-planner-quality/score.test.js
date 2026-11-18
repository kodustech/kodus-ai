// The scorer turns red on each failure it is for (evals/README.md rule 7):
// a right Run and the same Run broken one way at a time.
//   node --test evals/runtime-planner-quality/score.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    scoreAll,
    scoreRun,
    planShape,
    planSeconds,
    scoreAuthor,
    scoreExtractor,
    sameRoute,
    regateRun,
} = require('./score');

const label = {
    id: 'shop-2',
    repo: 'demo-shop',
    pr: 2,
    heads: ['aaaa1111'],
    acts: true,
    checks: 'probes POST /orders',
    reaches: [{ method: 'POST', path: '^/orders$' }],
    prefix: '^/',
    accept: ['regression'],
    files: {
        'server.js': {
            serves: ['POST /orders', 'GET /orders'],
            reaches: ['POST /orders'],
        },
    },
};
const probe = (method, path, status, extra = {}) => ({
    entryPoint: `${method} ${path}`,
    assertions: status ? { kind: 'http', status } : null,
    probe: {
        id: `${method}${path}`,
        spec: {
            kind: 'http',
            method,
            path,
            target: { service: 'app', port: 3000 },
            ...extra,
        },
    },
});
const run = (over = {}) => ({
    runId: 'r1aaaaaaaa',
    repo: 'example-org/demo-shop',
    pr: 2,
    headSha: 'aaaa1111ffff',
    verdict: 'regression',
    requestedAt: '2026-11-13T00:00:00Z',
    diff: [{ path: 'server.js', patch: '@@ -1 +1 @@\n-a\n+b', content: 'x' }],
    plan: {
        source: 'plan',
        probes: [probe('POST', '/orders', 400)],
        usage: { inputTokens: 10, outputTokens: 5 },
    },
    planTiming: { startedAt: 1_000, endedAt: 31_000, baseReadyAt: null },
    outcome: {
        probes: [
            {
                probeId: 'POST/orders',
                verdict: 'finding',
                baseStatus: 400,
                prStatus: 201,
            },
        ],
    },
    ...over,
});

test('a right Run is right on every check', () => {
    const s = scoreRun(run(), label);
    assert.equal(s.right, true);
    assert.equal(s.relevant, true);
    assert.deepEqual(s.expectation, { hits: 1, total: 1 });
    assert.equal(s.seconds, 30);
});

test('a verdict the case does not accept is wrong', () => {
    assert.equal(
        scoreRun(run({ verdict: 'partly_tested' }), label).right,
        false,
    );
});

test('a plan that probes only what the diff does not reach has no relevant probe', () => {
    const s = scoreRun(
        run({ plan: { probes: [probe('GET', '/health', 200)] } }),
        label,
    );
    assert.equal(s.relevant, false);
    assert.equal(s.right, false);
    assert.deepEqual(s.precision, { hits: 0, total: 1 });
});

test('a predicted status base did not answer is an expectation miss', () => {
    const s = scoreRun(
        run({
            outcome: {
                probes: [
                    { probeId: 'POST/orders', baseStatus: 415, prStatus: 415 },
                ],
            },
        }),
        label,
    );
    assert.deepEqual(s.expectation, { hits: 0, total: 1 });
});

test('a path outside the app prefix is counted', () => {
    const s = scoreRun(
        run({ plan: { probes: [probe('GET', '/server/ping', 200)] } }),
        { ...label, prefix: '^/api/' },
    );
    assert.deepEqual(s.prefix, { hits: 0, total: 1 });
});

test('a media-type label needs that header and a body', () => {
    const want = [{ contentType: '^text/plain' }];
    assert.equal(
        scoreRun(run({ plan: { probes: [probe('GET', '/healthz', 200)] } }), {
            ...label,
            reaches: want,
        }).relevant,
        false,
    );
    assert.equal(
        scoreRun(
            run({
                plan: {
                    probes: [
                        probe('GET', '/healthz', 200, {
                            headers: { 'Content-Type': 'text/plain' },
                            body: 'x',
                        }),
                    ],
                },
            }),
            { ...label, reaches: want },
        ).relevant,
        true,
    );
});

test('two Runs of one PR that end differently are unstable', () => {
    const traces = {
        runs: [
            run(),
            run({
                runId: 'r2bbbbbbbb',
                verdict: 'partly_tested',
                plan: { probes: [] },
            }),
        ],
        authors: [],
    };
    const s = scoreAll(traces, { cases: [label] });
    assert.equal(s.totals.stableCases[0].modalVerdictShare, 0.5);
    assert.equal(s.totals.stableCases[0].shapes, 2);
});

test('an excluded Run, named by its key and not its id, is left out of its case and of the unlabelled list', () => {
    const { runKey } = require('./score');
    const excludedRun = run({ runId: 'r2bbbbbbbb', verdict: 'partly_tested' });
    const s = scoreAll(
        { runs: [run(), excludedRun], authors: [] },
        {
            cases: [label],
            excludeRuns: { [runKey(excludedRun.runId)]: 'measured the cell' },
        },
    );
    assert.equal(s.totals.planned, 1);
    assert.match(runKey(excludedRun.runId), /^[0-9a-f]{12}$/);
    assert.ok(!runKey(excludedRun.runId).includes('r2bbbbbb'));
});

test('a Run that errored after planning is not measured', () => {
    const s = scoreAll(
        { runs: [run({ verdict: null })], authors: [] },
        { cases: [label] },
    );
    assert.equal(s.totals.planned, 0);
    assert.equal(s.noPlan, 1);
});

test('the early plan counts from the base ready, not the step start', () => {
    assert.equal(
        planSeconds(
            run({
                plan: { source: 'early' },
                planTiming: {
                    startedAt: 0,
                    baseReadyAt: 60_000,
                    endedAt: 100_000,
                },
            }),
        ),
        40,
    );
});

test('plan shapes fold ids', () => {
    assert.equal(
        planShape({
            probes: [probe('GET', '/orders/1'), probe('GET', '/orders/2')],
        }),
        'GET /orders/:n',
    );
});

test('the extractor misses a file that serves a route and over-maps routes the diff does not reach', () => {
    const none = scoreExtractor(run(), label, () => [
        {
            id: 'unmapped:server.js',
            kind: 'unmapped',
            match: { file: 'server.js' },
        },
    ]);
    assert.equal(none.files[0].mapped, false);
    const all = scoreExtractor(run(), label, () => [
        {
            id: 'POST /orders',
            kind: 'http_route',
            match: { file: 'server.js' },
        },
        { id: 'GET /orders', kind: 'http_route', match: { file: 'server.js' } },
    ]);
    assert.equal(all.files[0].mapped, true);
    assert.equal(all.files[0].overMapped, 1);
});

test('an author that ran out of budget did not boot; a model route that was down is not measured', () => {
    const out = scoreAuthor({
        status: 'no_recipe',
        reason: 'the token budget ran out before a recipe passed the checks',
        usage: { inputTokens: 362_000 },
        ms: 1,
    });
    assert.equal(out.booted, false);
    assert.equal(out.budgetOut, true);
    assert.equal(
        scoreAuthor({
            status: 'submitted',
            boot: 'blocked:toolchain/compose_up',
            ms: 1,
        }).booted,
        false,
    );
    assert.equal(
        scoreAuthor({ status: 'submitted', boot: 'ready', ms: 1 }).booted,
        true,
    );
    assert.ok(
        scoreAuthor({ status: 'unavailable', code: 'llm_unavailable', ms: 0 })
            .unmeasured,
    );
});

test('a route the PR adds is left out of the expectation check', () => {
    const s = scoreRun(
        run({
            outcome: {
                probes: [
                    { probeId: 'POST/orders', baseStatus: 404, prStatus: 200 },
                ],
            },
        }),
        label,
    );
    assert.equal(s.expectation, null);
});

test('a Run that ended nothing_to_test before boot is scored, with no plan and no model call; one outside accept is wrong', () => {
    const comment = {
        ...label,
        id: 'c',
        reaches: [],
        accept: ['nothing_to_test'],
    };
    const s = scoreAll(
        {
            runs: [
                run({
                    verdict: 'nothing_to_test',
                    plan: null,
                    planTiming: null,
                }),
                run({
                    runId: 'r2bbbbbbbb',
                    verdict: 'partly_tested',
                    plan: { source: 'plan', probes: [] },
                }),
            ],
            authors: [],
        },
        { cases: [comment] },
    );
    assert.equal(s.totals.planned, 2);
    assert.equal(s.noPlan, 0);
    assert.equal(s.totals.noModel, 2);
    assert.deepEqual(
        s.cases[0].scored.map((x) => [x.verdict, x.right]),
        [
            ['nothing_to_test', true],
            ['partly_tested', false],
        ],
    );
});

test('route mapping reads every route the file serves; a route that serves any method matches a label of one', () => {
    assert.equal(sameRoute('ALL /books', 'GET /books'), true);
    assert.equal(sameRoute('POST /books', 'GET /books'), false);
    const comment = {
        ...label,
        files: { 'server.js': { serves: ['GET /orders'], reaches: [] } },
    };
    const out = scoreExtractor(run(), comment, {
        extractEntryPoints: () => [],
        routesServedBy: () => ['ALL /orders'],
    });
    assert.equal(out.files[0].mapped, true);
    assert.equal(out.files[0].overMapped, 0);
});

// demo-nextjs#2: the PR rewords a feature line on purpose; main's text was asserted.
const PAGE_PATCH = [
    '@@ -32,4 +32,4 @@',
    '             <ul className="list-disc">',
    '               <li>Multi-stage Docker build</li>',
    '-              <li>Production-ready configuration</li>',
    '+              <li>Production configuration, ready to deploy</li>',
].join('\n');
const pageLabel = {
    id: 'nextjs-2-page-text',
    repo: 'demo-nextjs',
    pr: 2,
    heads: ['1b0ad40e'],
    acts: true,
    checks: 'reports the reworded line as the intended change',
    reaches: [{ kind: 'browser' }],
    accept: ['partly_tested'],
    intended: true,
};
const pageRun = (over = {}) => {
    const fields = (side) =>
        side === 'base'
            ? {
                  'steps': 'ok,ok,ok',
                  'step.1.value':
                      'Multi-stage Docker build\nProduction-ready configuration',
              }
            : {
                  'steps': 'ok,fail:mismatch,fail:skipped',
                  'step.1.value':
                      'Multi-stage Docker build\nProduction configuration, ready to deploy',
              };
    return {
        runId: 'r2bbbbbbbb',
        repo: 'example-org/demo-nextjs',
        pr: 2,
        headSha: '1b0ad40eff',
        verdict: 'regression',
        requestedAt: '2026-11-13T18:22:39Z',
        diff: [{ path: 'app/page.tsx', patch: PAGE_PATCH }],
        plan: {
            source: 'plan',
            probes: [
                {
                    entryPoint: 'GET /',
                    probe: {
                        id: 'page',
                        spec: {
                            kind: 'browser',
                            steps: [
                                { goto: '/' },
                                {
                                    expectText: [
                                        'ul',
                                        'Production-ready configuration',
                                    ],
                                },
                                { screenshot: 'f' },
                            ],
                        },
                    },
                },
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
        },
        outcome: {
            probes: [
                {
                    probeId: 'page',
                    entryPoint: 'GET /',
                    verdict: 'finding',
                    findingKind: 'behavior_change',
                    intent: 'uncertain',
                    differingFields: ['steps', 'step.1.value'],
                },
            ],
        },
        replay: ['base', 'base', 'pr', 'pr'].map((side, i) => ({
            index: 0,
            probeId: 'page',
            side,
            round: (i % 2) + 1,
            transport: 'ok',
            vmHealth: 'ok',
            timedOut: false,
            fields: fields(side),
        })),
        ...over,
    };
};

test('a case the PR means is right only when a probe reports the intended change', () => {
    assert.equal(scoreRun(pageRun(), pageLabel).right, false);
    assert.equal(
        scoreRun(pageRun({ verdict: 'partly_tested' }), pageLabel).right,
        false,
    );
    const intended = pageRun({
        verdict: 'partly_tested',
        outcome: {
            probes: [
                { probeId: 'page', verdict: 'finding', intent: 'intended' },
            ],
        },
    });
    assert.equal(scoreRun(intended, pageLabel).right, true);
});

test('regate: the recorded rounds decided again by the current gate turn the false regression into the intended change', () => {
    require('../shared/eval-kit').registerTs();
    const {
        decideIntendedChange,
    } = require('../../libs/runtime/gate/intended-change.ts');
    const r = regateRun(pageRun(), decideIntendedChange);
    assert.equal(r.recordedVerdict, 'regression');
    assert.equal(r.verdict, 'partly_tested');
    assert.equal(r.outcome.probes[0].intent, 'intended');
    assert.equal(scoreRun(r, pageLabel).right, true);
});

test('regate keeps a real regression: a value the diff does not change', () => {
    require('../shared/eval-kit').registerTs();
    const {
        decideIntendedChange,
    } = require('../../libs/runtime/gate/intended-change.ts');
    const broken = pageRun();
    broken.replay = broken.replay.map((s) =>
        s.side === 'pr'
            ? {
                  ...s,
                  fields: {
                      ...s.fields,
                      'step.1.value': 'Multi-stage Docker build\nUndefined',
                  },
              }
            : s,
    );
    const r = regateRun(broken, decideIntendedChange);
    assert.equal(r.verdict, 'regression');
    assert.equal(r.outcome.probes[0].intent, 'uncertain');
});

test('regate leaves a Run with no recorded rounds as it was', () => {
    const r = pageRun({ replay: undefined });
    assert.equal(
        regateRun(r, () => assert.fail('not called')),
        r,
    );
});

// demo-nextjs#2 over HTTP: the body digest varied per request, so the change was masked.
const httpPageRun = (
    prLine,
    { prRounds = 2, verdict = 'partly_tested' } = {},
) => {
    const page = (line, requestId) =>
        `<!DOCTYPE html><html><body><ul class="list-disc"><li>Multi-stage Docker build</li><li>${line}</li></ul><script>self.__next_r="${requestId}"</script></body></html>`;
    const round = (side, n, line) => ({
        index: 0,
        probeId: 'home',
        side,
        round: n,
        transport: 'ok',
        vmHealth: 'ok',
        timedOut: false,
        expectedHolds: true,
        fields: {
            'status': '200',
            'json': 'not_json',
            'body.sha256': `${side}${n}`,
        },
        response: {
            contentType: 'text/html; charset=utf-8',
            body: page(line, `${side}${n}`),
        },
    });
    return pageRun({
        verdict,
        plan: {
            source: 'plan',
            probes: [
                {
                    entryPoint: 'GET /',
                    probe: {
                        id: 'home',
                        spec: { kind: 'http', method: 'GET', path: '/' },
                    },
                },
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
        },
        outcome: {
            probes: [
                {
                    probeId: 'home',
                    entryPoint: 'GET /',
                    verdict: 'not_reproduced',
                    differingFields: [],
                },
            ],
        },
        replay: [
            round('base', 1, 'Production-ready configuration'),
            round('base', 2, 'Production-ready configuration'),
            ...Array.from({ length: prRounds }, (_, i) =>
                round('pr', i + 1, prLine),
            ),
        ],
    });
};
const currentGate = () => {
    require('../shared/eval-kit').registerTs();
    return {
        intendedChange: require('../../libs/runtime/gate/intended-change.ts')
            .decideIntendedChange,
        decideProbe: require('../../libs/runtime/gate/gate.ts').decideProbe,
        notJsonBodyFields: require('../../libs/runtime/gate/probe-fields.ts')
            .notJsonBodyFields,
    };
};

test('regate with recorded bodies: an HTML page is compared by its text again, and the reword the diff spells out is intended', () => {
    const r = regateRun(
        httpPageRun('Production configuration, ready to deploy'),
        currentGate(),
    );
    assert.equal(r.outcome.probes[0].verdict, 'finding');
    assert.equal(r.outcome.probes[0].regatedFrom, 'not_reproduced');
    assert.equal(r.outcome.probes[0].intent, 'intended');
    assert.equal(r.verdict, 'partly_tested');
    assert.equal(
        scoreRun(r, { ...pageLabel, reaches: [{ method: 'GET', path: '^/$' }] })
            .right,
        true,
    );
});

test('regate with recorded bodies: a text the diff does not change is a regression; a round never played is not measured unless assumed', () => {
    const broken = regateRun(
        httpPageRun('Undefined', { verdict: 'no_regressions' }),
        currentGate(),
    );
    assert.equal(broken.outcome.probes[0].verdict, 'finding');
    assert.notEqual(broken.outcome.probes[0].intent, 'intended');
    assert.equal(broken.verdict, 'regression');

    const short = httpPageRun('Production configuration, ready to deploy', {
        prRounds: 1,
    });
    const left = regateRun(short, currentGate());
    assert.equal(left.needsRound, 1);
    assert.equal(left.outcome.probes[0].verdict, 'not_reproduced');
    const assumed = regateRun(short, { ...currentGate(), repeatRounds: true });
    assert.equal(assumed.assumedRounds, 1);
    assert.equal(assumed.outcome.probes[0].intent, 'intended');
});
