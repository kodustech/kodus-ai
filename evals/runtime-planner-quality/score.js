// Scores what Kody Runtime's planner and recipe author did in the product,
// from the traces export.js reads, against the labels in cases.json. Every
// check here is code: a probe's request against a regex, a predicted status
// against the one base answered, a verdict against a list. Nothing is judged.

const { createHash } = require('node:crypto');

const short = (sha) => String(sha || '').slice(0, 8);
/**
 * How cases.json names a Run it excludes: a digest of the Run id's first 8
 * characters, so the committed labels do not list Run ids. It is a label,
 * not a secret: 8 hex characters are 32 bits, and anyone can find the prefix
 * by brute force. The export holds the ids; `runKey` of an exported Run
 * finds its exclusion.
 */
const runKey = (runId) =>
    createHash('sha256').update(short(runId)).digest('hex').slice(0, 12);
/** The verdict of a diff that changes nothing that runs (no-effect.ts): decided before boot, with no plan. */
const NOTHING_TO_TEST = 'nothing_to_test';
const repoName = (r) =>
    String(r || '')
        .split('/')
        .pop();

/** The case a Run belongs to: same repository name, PR and head. */
function caseOf(run, cases) {
    return cases.find(
        (c) =>
            c.repo === repoName(run.repo) &&
            c.pr === run.pr &&
            c.heads.some((h) => short(run.headSha).startsWith(h)),
    );
}

const headerOf = (spec, name) => {
    const h = spec?.headers || {};
    const k = Object.keys(h).find((x) => x.toLowerCase() === name);
    return k ? String(h[k]) : undefined;
};

/** Whether a planned probe matches one `reaches` entry of the labels. */
function probeReaches(p, want) {
    const spec = p.probe?.spec || {};
    if (want.kind && want.kind !== spec.kind) return false;
    if (want.kind === 'browser') return true;
    if (spec.kind !== 'http') return false;
    if (want.method && String(spec.method).toUpperCase() !== want.method)
        return false;
    if (
        want.path &&
        !new RegExp(want.path).test(String(spec.path || '').split('?')[0])
    )
        return false;
    if (want.contentType) {
        const ct = headerOf(spec, 'content-type');
        if (!ct || !new RegExp(want.contentType, 'i').test(ct) || !spec.body)
            return false;
    }
    return true;
}

/** "METHOD path" per probe, ids and numbers folded, sorted: two plans with the same shape probe the same requests. */
function planShape(plan) {
    const items = (plan?.probes || []).map((p) => {
        const s = p.probe?.spec || {};
        if (s.kind !== 'http') return s.kind || 'other';
        const ct = headerOf(s, 'content-type');
        return `${String(s.method).toUpperCase()} ${String(s.path || '').replace(/\/\d+(?=\/|$)/g, '/:n')}${ct ? ` [${ct.split(';')[0]}]` : ''}`;
    });
    return [...new Set(items)].sort().join(' | ') || '(no probe)';
}

/**
 * Seconds the planner itself took. A plan made while the PR boots starts
 * with the Run and first waits for the base: its time counts from the base's
 * ready. A plan with no model call (plan-without-model.ts) takes ~0.
 */
function planSeconds(run) {
    const t = run.planTiming;
    if (!Number.isFinite(t?.startedAt) || !Number.isFinite(t?.endedAt))
        return null;
    const from =
        run.plan?.source === 'early' && t.baseReadyAt
            ? Math.max(t.startedAt, t.baseReadyAt)
            : t.startedAt;
    return Math.max(0, (t.endedAt - from) / 1000);
}

const modelCalled = (plan) =>
    (plan?.usage?.inputTokens || 0) + (plan?.usage?.outputTokens || 0) > 0;

/** One Run against its case: each check right or wrong, null when it does not apply. */
function scoreRun(run, c) {
    const plan = run.plan;
    const probes = plan?.probes || [];
    const http = probes.filter((p) => p.probe?.spec?.kind === 'http');
    const outcome = new Map(
        (run.outcome?.probes || []).map((o) => [o.probeId, o]),
    );
    const reaching = c.reaches.length
        ? probes.filter((p) => c.reaches.some((w) => probeReaches(p, w)))
        : [];
    // A route the PR adds is absent on base (404 there, something else on the PR): what the planner predicts for it is the PR's answer, not base's.
    const newOnPr = (o) =>
        o.baseStatus === 404 &&
        Number.isInteger(o.prStatus) &&
        o.prStatus !== 404;
    const predicted = http.filter(
        (p) =>
            Number.isInteger(p.assertions?.status) &&
            Number.isInteger(outcome.get(p.probe?.id)?.baseStatus) &&
            !newOnPr(outcome.get(p.probe.id)),
    );
    const expectRight = predicted.filter(
        (p) => p.assertions.status === outcome.get(p.probe.id).baseStatus,
    );
    const prefixRight = c.prefix
        ? http.filter((p) =>
              new RegExp(c.prefix).test(String(p.probe?.spec?.path || '')),
          )
        : [];
    const relevant = c.reaches.length ? reaching.length > 0 : null;
    // A case whose change the PR means (`intended`): right only when a probe reports it as the PR's intended change.
    const intendedShown = (run.outcome?.probes || []).some(
        (o) => o.verdict === 'finding' && o.intent === 'intended',
    );
    const verdictOk =
        c.accept.includes(run.verdict) && (!c.intended || intendedShown);
    return {
        runId: short(run.runId),
        at: run.requestedAt,
        verdict: run.verdict,
        ...(run.recordedVerdict && run.recordedVerdict !== run.verdict
            ? { recordedVerdict: run.recordedVerdict }
            : {}),
        intendedShown,
        shape: planShape(plan),
        probes: probes.length,
        model: modelCalled(plan),
        relevant,
        precision:
            c.reaches.length && probes.length
                ? { hits: reaching.length, total: probes.length }
                : null,
        prefix:
            c.prefix && http.length
                ? { hits: prefixRight.length, total: http.length }
                : null,
        expectation: predicted.length
            ? { hits: expectRight.length, total: predicted.length }
            : null,
        expectationMisses: predicted
            .filter((p) => !expectRight.includes(p))
            .map(
                (p) =>
                    `${p.probe.spec.method} ${p.probe.spec.path}: expected ${p.assertions.status}, base ${outcome.get(p.probe.id).baseStatus}`,
            ),
        verdictOk,
        // Right: the verdict is one a right plan ends in, and the plan probed what the diff reaches when it reaches anything.
        right: verdictOk && relevant !== false,
        seconds: planSeconds(run),
        tokensIn: plan?.usage?.inputTokens || 0,
        tokensOut: plan?.usage?.outputTokens || 0,
    };
}

/** Of the Runs of one case: the share that ended in the most common verdict, and how many plan shapes they used. */
function stability(scored) {
    if (scored.length < 2) return null;
    const count = (key) =>
        scored.reduce(
            (m, s) => m.set(s[key], (m.get(s[key]) || 0) + 1),
            new Map(),
        );
    const verdicts = count('verdict');
    const modal = Math.max(...verdicts.values());
    return {
        runs: scored.length,
        modalVerdictShare: modal / scored.length,
        verdicts: Object.fromEntries(verdicts),
        shapes: count('shape').size,
    };
}

/** `METHOD /path` against a label: same path, and the same method or one that serves any (`ALL`). */
function sameRoute(a, b) {
    const [ma, pa] = String(a).split(' ');
    const [mb, pb] = String(b).split(' ');
    return pa === pb && (ma === mb || ma === 'ALL' || mb === 'ALL');
}

/**
 * Production's entry-point extractor on a case's changed files. Route
 * mapping: does it see, in each file that serves a route, one of those
 * routes (routesServedBy: what the file declares, whatever the diff touched).
 * Over-mapping: the routes extractEntryPoints hands the planner for the
 * file that the diff's lines do not reach.
 */
function scoreExtractor(run, c, extract) {
    if (!c.files || !run) return null;
    const { extractEntryPoints, routesServedBy } =
        typeof extract === 'function'
            ? { extractEntryPoints: extract }
            : extract;
    const files = run.diff.filter((d) => c.files[d.path]);
    if (!files.length || files.some((f) => f.content === undefined))
        return { unmeasured: 'the trace has no content for a labelled file' };
    const eps = extractEntryPoints(
        run.diff.map((d) => ({
            path: d.path,
            patch: d.patch,
            content: d.content,
        })),
    );
    const out = [];
    for (const f of files) {
        const label = c.files[f.path];
        const routes = eps
            .filter((e) => e.kind === 'http_route' && e.match.file === f.path)
            .map((e) => e.id);
        const seen = routesServedBy
            ? routesServedBy({
                  path: f.path,
                  patch: f.patch,
                  content: f.content,
              })
            : routes;
        out.push({
            file: f.path,
            serves: label.serves.length,
            mapped: label.serves.length
                ? seen.some((r) => label.serves.some((x) => sameRoute(r, x)))
                : null,
            routes,
            overMapped: routes.filter(
                (r) => !label.reaches.some((x) => sameRoute(r, x)),
            ).length,
        });
    }
    return { files: out };
}

/** One recipe author or repair call: did its recipe boot, and did it end on the token budget. */
function scoreAuthor(a) {
    if (a.status === 'unavailable')
        return {
            unmeasured: `the model route did not answer (${a.code || 'unavailable'})`,
        };
    return {
        repo: repoName(a.repo),
        at: a.at,
        step: a.step,
        submitted: a.status === 'submitted',
        booted: a.status === 'submitted' && a.boot === 'ready',
        budgetOut: /token budget/.test(a.reason || ''),
        refused: /checks refused/.test(a.reason || ''),
        boot: a.boot,
        reason: a.reason,
        tokensIn: a.usage?.inputTokens || 0,
        tokensOut: a.usage?.outputTokens || 0,
        seconds: a.ms / 1000,
    };
}

const quantile = (xs, q) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
const ratio = (items) => {
    const total = sum(items, (x) => x.total);
    return {
        hits: sum(items, (x) => x.hits),
        total,
        value: total ? sum(items, (x) => x.hits) / total : null,
    };
};
const share = (items, f) => ({
    hits: items.filter(f).length,
    total: items.length,
    value: items.length ? items.filter(f).length / items.length : null,
});

/**
 * A Run's probes decided again on its recorded replay rounds by the current
 * gate (`regate`, production's functions passed in by run.js):
 *
 * - a round that carries its recorded body (`response`, exported from the
 *   worker's evidence) has the fields of that body derived again
 *   (`notJsonBodyFields`: an HTML page's text and markup, any other body's
 *   digest), and the probe is decided again by `decideProbe` on the
 *   recorded rounds. When the new fields decide the same verdict as the
 *   recorded ones, the recorded outcome stands (a later step such as a new
 *   endpoint kept); when they decide another, it replaces it. A decision
 *   that asks for a round the replay never played is not measured: the
 *   recorded outcome stands and the probe is counted in `needsRound`; with
 *   `repeatRounds` (an assumption the output names) the last recorded round
 *   of each side asked for is played again instead, as a same build answered
 *   in every recorded pair (planner-eval.md), and the probe is counted in
 *   `assumedRounds`.
 * - a `behavior_change` finding goes through `decideIntendedChange`: one the
 *   diff spells out becomes intended, or inconclusive when one side skipped
 *   steps after the change.
 *
 * The Run's verdict follows decideRunVerdict (run-state.ts): an unintended
 * finding is a regression; with none left, a regression or a newly intended
 * finding is partly tested. A Run with no recorded rounds is left as it was.
 */
function regateRun(run, regate) {
    const { intendedChange, decideProbe, notJsonBodyFields, repeatRounds } =
        typeof regate === 'function' ? { intendedChange: regate } : regate;
    const probes = run.outcome?.probes || [];
    const rederive =
        !!decideProbe &&
        !!notJsonBodyFields &&
        (run.replay || []).some((s) => s.response);
    if (
        !run.replay?.length ||
        (!rederive && !probes.some((o) => o.verdict === 'finding'))
    )
        return run;
    const planned = run.plan?.probes || [];
    // The k-th verdict of a probe id is the k-th plan index that replayed it (a boot finding has no rounds).
    const indexesOf = (id) =>
        [
            ...new Set(
                run.replay.filter((s) => s.probeId === id).map((s) => s.index),
            ),
        ].sort((a, b) => a - b);
    const withFields = (s) => {
        if (!s.response) return s;
        const fields = { ...s.fields };
        delete fields['body.sha256'];
        return {
            ...s,
            fields: {
                ...fields,
                ...notJsonBodyFields(
                    s.response.contentType
                        ? { 'content-type': s.response.contentType }
                        : {},
                    s.response.body,
                ),
            },
        };
    };
    const asFinding = (o, decision) => ({
        kind: 'verdict',
        verdict: 'finding',
        findingKind: o.findingKind,
        reason: '',
        differingFields: decision?.differingFields ?? (o.differingFields || []),
        maskedFields: [],
    });
    const seen = new Map();
    let needsRound = 0;
    let assumedRounds = 0;
    const next = probes.map((o) => {
        const k = seen.get(o.probeId) || 0;
        seen.set(o.probeId, k + 1);
        const index = indexesOf(o.probeId)[k];
        const recorded = run.replay
            .filter((s) => s.index === index && s.probeId === o.probeId)
            .map((s, i) => ({
                ...s,
                stepId: `${o.probeId}-${i}`,
                executor: 'observer',
                imageId: 'recorded',
            }));
        const spec = planned.find((p) => p.probe?.id === o.probeId)?.probe
            ?.spec;
        const explain = (decision, out) => {
            if (
                !intendedChange ||
                out.verdict !== 'finding' ||
                out.intent === 'intended' ||
                out.findingKind !== 'behavior_change'
            )
                return out;
            const d = intendedChange(decision, steps, {
                diff: run.diff || [],
                ...(spec?.kind === 'browser'
                    ? {
                          browserStepKinds: spec.steps.map(
                              (x) => Object.keys(x)[0],
                          ),
                      }
                    : {}),
            });
            if (!d.intendedChange) return out;
            return d.verdict === 'finding'
                ? {
                      ...out,
                      intent: 'intended',
                      intendedChange: d.intendedChange,
                  }
                : {
                      ...out,
                      verdict: d.verdict,
                      findingKind: null,
                      intendedChange: d.intendedChange,
                  };
        };
        let steps = recorded;
        if (!rederive || !recorded.some((s) => s.response))
            return explain(asFinding(o), o);
        steps = recorded.map(withFields);
        const gate = (rounds) =>
            decideProbe(rounds, { pinnedImageId: 'recorded' });
        let now = gate(steps);
        let repeated = 0;
        for (
            let guard = 0;
            now.kind !== 'verdict' && repeatRounds && guard < 6;
            guard++
        ) {
            for (const side of ['base', 'pr']) {
                for (let n = 0; n < now[side]; n++) {
                    const last = steps.filter((x) => x.side === side).at(-1);
                    if (!last) continue;
                    steps = [
                        ...steps,
                        {
                            ...last,
                            round: last.round + 1,
                            stepId: `${last.stepId}+`,
                        },
                    ];
                    repeated++;
                }
            }
            now = gate(steps);
        }
        if (now.kind !== 'verdict') {
            needsRound++;
            return { ...o, needsRound: true };
        }
        if (repeated) assumedRounds++;
        const before = gate(recorded);
        if (before.kind === 'verdict' && before.verdict === now.verdict)
            return explain(asFinding(o, now), {
                ...o,
                ...(o.verdict === 'finding'
                    ? { differingFields: now.differingFields }
                    : {}),
            });
        return explain(now, {
            ...o,
            verdict: now.verdict,
            findingKind: now.findingKind ?? null,
            intent: null,
            differingFields: now.differingFields,
            regatedFrom: o.verdict,
        });
    });
    const findings = next.filter((o) => o.verdict === 'finding');
    const unintended = findings.some((o) => o.intent !== 'intended');
    const moved = next.some((o, i) => o.verdict !== probes[i].verdict);
    const verdict = unintended
        ? run.verdict === 'regression' || !moved
            ? run.verdict
            : 'regression'
        : run.verdict === 'regression' ||
            (run.verdict === 'no_regressions' && findings.length)
          ? 'partly_tested'
          : run.verdict;
    return {
        ...run,
        recordedVerdict: run.verdict,
        verdict,
        needsRound,
        assumedRounds,
        outcome: { ...run.outcome, probes: next },
    };
}

/** Everything over a set of traces: per case, per Run, and the totals. */
function scoreAll(traces, labels, opts = {}) {
    const {
        extractEntryPoints,
        routesServedBy,
        since,
        runIds,
        intendedChange,
        decideProbe,
        notJsonBodyFields,
        repeatRounds,
    } = opts;
    const excluded = new Set(Object.keys(labels.excludeRuns || {}));
    const inWindow = (at) => !since || new Date(at) >= new Date(since);
    const runs = traces.runs
        .filter(
            (r) =>
                inWindow(r.requestedAt) &&
                (!runIds || runIds.some((id) => r.runId.startsWith(id))),
        )
        .map((r) =>
            intendedChange
                ? regateRun(r, {
                      intendedChange,
                      decideProbe,
                      notJsonBodyFields,
                      repeatRounds,
                  })
                : r,
        );
    const cases = [];
    const unlabelled = [];
    let noPlan = 0;
    for (const c of labels.cases) {
        const mine = runs.filter(
            (r) => caseOf(r, [c]) && !excluded.has(runKey(r.runId)),
        );
        // A Run with no plan (it never booted) or no verdict (it errored after planning) measured no plan.
        // nothing_to_test is decided before anything boots, from the diff alone: a plan of no probe, made with no model.
        const planned = mine.filter(
            (r) => (r.plan && r.verdict) || r.verdict === NOTHING_TO_TEST,
        );
        noPlan += mine.length - planned.length;
        if (!mine.length) continue;
        const scored = planned.map((r) => scoreRun(r, c));
        const latest = [...mine].reverse().find((r) => r.diff?.length);
        cases.push({
            id: c.id,
            checks: c.checks,
            acts: c.acts,
            runs: mine.length,
            scored,
            stability: stability(scored),
            extractor: extractEntryPoints
                ? scoreExtractor(latest, c, {
                      extractEntryPoints,
                      routesServedBy,
                  })
                : null,
        });
    }
    for (const r of runs)
        if (
            (r.plan || r.verdict === NOTHING_TO_TEST) &&
            r.verdict &&
            !excluded.has(runKey(r.runId)) &&
            !caseOf(r, labels.cases)
        )
            unlabelled.push(
                `${repoName(r.repo)}#${r.pr}@${short(r.headSha)} (${short(r.runId)})`,
            );

    const all = cases.flatMap((c) => c.scored);
    const modelRuns = all.filter((s) => s.model);
    const extractorFiles = cases.flatMap((c) => c.extractor?.files || []);
    const authors = (opts.authors ?? traces.authors ?? [])
        .filter((a) => inWindow(a.at))
        .map(scoreAuthor);
    const measuredAuthors = authors.filter((a) => !a.unmeasured);
    const seconds = modelRuns.map((s) => s.seconds).filter((x) => x !== null);
    return {
        cases,
        unlabelled,
        noPlan,
        totals: {
            planned: all.length,
            right: share(all, (s) => s.right),
            verdict: share(all, (s) => s.verdictOk),
            relevant: share(
                all.filter((s) => s.relevant !== null),
                (s) => s.relevant,
            ),
            precision: ratio(all.map((s) => s.precision).filter(Boolean)),
            prefix: ratio(all.map((s) => s.prefix).filter(Boolean)),
            expectation: ratio(all.map((s) => s.expectation).filter(Boolean)),
            stableCases: cases
                .filter((c) => c.stability)
                .map((c) => ({ id: c.id, ...c.stability })),
            routeMapping: share(
                extractorFiles.filter((f) => f.mapped !== null),
                (f) => f.mapped,
            ),
            overMapped: {
                routes: sum(extractorFiles, (f) => f.overMapped),
                files: extractorFiles.filter((f) => f.overMapped > 0).length,
                of: extractorFiles.length,
            },
            planSeconds: {
                runs: seconds.length,
                p50: quantile(seconds, 0.5),
                p90: quantile(seconds, 0.9),
                max: seconds.length ? Math.max(...seconds) : null,
            },
            planTokens: {
                in: sum(modelRuns, (s) => s.tokensIn),
                out: sum(modelRuns, (s) => s.tokensOut),
                p50In: quantile(
                    modelRuns.map((s) => s.tokensIn),
                    0.5,
                ),
            },
            noModel: all.length - modelRuns.length,
            author: {
                calls: authors.length,
                unmeasured: authors.length - measuredAuthors.length,
                booted: share(measuredAuthors, (a) => a.booted),
                submitted: share(measuredAuthors, (a) => a.submitted),
                budgetOut: share(measuredAuthors, (a) => a.budgetOut),
                p50In: quantile(
                    measuredAuthors.map((a) => a.tokensIn),
                    0.5,
                ),
                p50Seconds: quantile(
                    measuredAuthors.map((a) => a.seconds),
                    0.5,
                ),
            },
        },
        authors: measuredAuthors,
        regated: intendedChange
            ? {
                  runsMoved: runs.filter(
                      (r) =>
                          r.recordedVerdict && r.recordedVerdict !== r.verdict,
                  ).length,
                  probesMoved: sum(
                      runs,
                      (r) =>
                          (r.outcome?.probes || []).filter((o) => o.regatedFrom)
                              .length,
                  ),
                  intended: sum(
                      runs,
                      (r) =>
                          (r.outcome?.probes || []).filter(
                              (o) => o.intendedChange,
                          ).length,
                  ),
                  roundsWithBody: sum(
                      runs,
                      (r) => (r.replay || []).filter((x) => x.response).length,
                  ),
                  needsRound: sum(runs, (r) => r.needsRound || 0),
                  assumedRounds: sum(runs, (r) => r.assumedRounds || 0),
              }
            : null,
    };
}

module.exports = {
    runKey,
    caseOf,
    probeReaches,
    planShape,
    planSeconds,
    scoreRun,
    stability,
    scoreExtractor,
    sameRoute,
    scoreAuthor,
    regateRun,
    scoreAll,
};
