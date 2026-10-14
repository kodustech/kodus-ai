// The result every eval writes: the question it answers, what each case
// checked and how it came out, and the number its gate reads. One shape, so the
// nightly, the stage signals and the quality panel read every eval the same way
// instead of one parser per eval (evals/AGENTS.md).
//
//   {
//     eval:     'kody-rules',                       // the eval's folder under evals/
//     question: 'Does the Kody Rules agent flag…',  // its README's **Answers** line
//     model, runs,
//     metric:   { name, value, floor, baseline },   // ratios; floor from the eval's targets file
//     cases:    [{ id, checks, hits, total, detail: [{ what, ok }] }],
//     tokens:   { in, out, cacheRead },
//     infra:    { errored, total },                 // runs that did not measure
//   }
//
// A case says in one sentence what it checks (`checks`), and its outcome as
// counts (`hits` of `total`): the known bugs found, the violation sites flagged.
// `detail` lists those items when the eval knows them.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// The **Answers** line of an eval's README: the question the eval answers. The
// preflight already requires it in every README, so it is the one place the
// question is written.
function evalQuestion(evalPath) {
    if (!evalPath) return null;
    const readme = path.join(ROOT, evalPath, 'README.md');
    if (!fs.existsSync(readme)) return null;
    const line = fs.readFileSync(readme, 'utf8').split('\n').find((l) => /\*\*Answers:\*\*/.test(l));
    return line ? line.replace(/^.*\*\*Answers:\*\*\s*/, '').trim() || null : null;
}

// What is wrong with a result, or [] when it has the shape above.
function resultProblems(result) {
    const problems = [];
    if (!result || typeof result !== 'object') return ['no result'];
    for (const key of ['eval', 'question', 'model']) if (!result[key]) problems.push(`missing ${key}`);
    if (!result.metric || !Number.isFinite(result.metric.value)) problems.push('missing metric.value');
    const cases = Array.isArray(result.cases) ? result.cases : [];
    if (!cases.length) problems.push('no cases');
    for (const c of cases) {
        if (!c.id) problems.push('a case without id');
        if (!c.checks) problems.push(`case ${c.id}: no checks sentence`);
        if (!Number.isInteger(c.hits) || !Number.isInteger(c.total) || c.hits < 0 || c.hits > c.total) problems.push(`case ${c.id}: hits/total ${c.hits}/${c.total}`);
    }
    return problems;
}

// Two runs as one, over the cases BOTH runs have (evals/AGENTS.md: never two
// different subsets): counts summed, an item ok only when ok in both.
function poolCases(a = [], b = []) {
    const byId = new Map(b.map((c) => [c.id, c]));
    return a.filter((c) => byId.has(c.id)).map((c) => {
        const other = byId.get(c.id);
        const okIn = new Map((other.detail || []).map((d) => [d.what, d.ok]));
        return {
            ...c,
            hits: c.hits + other.hits,
            total: c.total + other.total,
            detail: (c.detail || []).map((d) => ({ ...d, ok: d.ok && okIn.get(d.what) !== false })),
        };
    });
}

// The cases as the stage signal carries them: every case, its detail capped so
// one row stays small in BigQuery.
const MAX_DETAIL = 12;
const MAX_TEXT = 160;
function signalCases(cases = []) {
    const clip = (s) => (String(s).length > MAX_TEXT ? `${String(s).slice(0, MAX_TEXT - 1)}…` : String(s));
    return cases.map((c) => ({
        id: c.id,
        checks: clip(c.checks),
        hits: c.hits,
        total: c.total,
        ...(c.detail && c.detail.length ? { detail: c.detail.slice(0, MAX_DETAIL).map((d) => ({ what: clip(d.what), ok: Boolean(d.ok) })) } : {}),
        ...(c.detail && c.detail.length > MAX_DETAIL ? { more: c.detail.length - MAX_DETAIL } : {}),
        ...(c.unmeasured ? { unmeasured: true } : {}),
    }));
}

module.exports = { evalQuestion, resultProblems, poolCases, signalCases, MAX_DETAIL };
