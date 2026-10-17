// Production repost shapes as review-rounds cases (#2114).
//
// Each spec in ./cases/*.js reproduces the SHAPE of one repost found in a
// production sample (500 later-round comments, 2026-10-05→12) with invented
// code: which agent posted it, how the earlier comment was stored, what the
// developer did to the code, where the problem sits now, how long the history
// was. Customer code never lands here.
//
// A spec:
//   id, shape         — case id and the production shape in one line
//   agent             — 'kody-rules' | 'finder'
//   rule?             — { uuid, title, rule } the earlier comment and the claims are about
//   base, head        — { path: text } before and at the reviewed head; a path
//                       missing from base is a file new in the PR
//   earlier?          — { file, lines: [s, e], label, status, text } the comment
//                       already on the PR (omitted for guard cases without one)
//   historySize       — entries the review is shown; 'out-of-40' puts the
//                       earlier comment behind 45 newer ones (MAX_PR_DECISIONS)
//   claims            — [{ id, at?: { file, lines }, golden, expect }]
//
// build() turns a spec into a case and its `-control` twin (no earlier comment;
// a claim that must not be posted again must be posted there).
const { structuredPatch } = require('diff');
const { TEAM_RULES, otherComments, commitList } = require('../fixtures/prod-profile');

const DECIDED_AT = '2026-10-06T12:00:00Z';

// The file's patch as the platform returns it: its unified hunks, no header.
function patchFor(filename, before, after) {
    const p = structuredPatch(filename, filename, before ?? '', after, '', '', { context: 3 });
    if (!p.hunks.length) return null;
    const body = p.hunks
        .map((h) => {
            const oldStart = h.oldLines === 0 ? 0 : h.oldStart;
            return `@@ -${oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`;
        })
        .join('\n');
    return { filename, patch: body };
}

// The head lines a patch adds.
function addedLines(patch) {
    const added = new Set();
    let n = 0;
    for (const l of String(patch || '').split('\n')) {
        const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
        if (h) n = Number(h[1]);
        else if (l.startsWith('+')) added.add(n++);
        else if (l.startsWith(' ')) n++;
    }
    return added;
}

function changedFiles(spec) {
    return Object.keys(spec.head)
        .map((f) => patchFor(f, spec.base[f], spec.head[f]))
        .filter(Boolean);
}

// Fillers: earlier comments on other files of the same PR. Production showed
// up to 44; prod-profile holds 15 distinct ones, so larger histories reuse
// them on other lines.
function fillers(count, start) {
    const base = otherComments(15, start);
    return Array.from({ length: count }, (_, i) => {
        const b = base[i % base.length];
        const round = Math.floor(i / base.length);
        return {
            ...b,
            suggestionId: `round-a-other-${i + 1}`,
            relevantLinesStart: b.relevantLinesStart + round * 40,
            relevantLinesEnd: b.relevantLinesEnd + round * 40,
            decidedAt: new Date(Date.parse(start) + i * 5 * 60e3).toISOString(),
        };
    });
}

// The code the earlier comment pointed at, as production stores it with the
// suggestion (`existingCode`): its lines in the version before this diff.
function earlierCode(spec) {
    const text = spec.base?.[spec.earlier.file];
    if (!text) return undefined;
    const [start, end] = spec.earlier.lines;
    return text.split('\n').slice(start - 1, end).join('\n') || undefined;
}

function history(spec) {
    if (!spec.earlier) return fillers(Math.max(0, (spec.historySize || 1) - 1), DECIDED_AT);
    const e = spec.earlier;
    const entry = {
        suggestionId: `round-a-${spec.id}`,
        relevantFile: e.file,
        relevantLinesStart: e.lines[0],
        relevantLinesEnd: e.lines[1],
        suggestionContent: e.text,
        existingCode: earlierCode(spec),
        label: e.label,
        ...(e.label === 'kody_rules' && spec.rule ? { brokenKodyRulesIds: [spec.rule.uuid] } : {}),
        outcome: e.status,
        decidedAt: DECIDED_AT,
    };
    if (spec.historySize === 'out-of-40') {
        // 45 comments posted after it: capDecisions keeps the 40 most recent.
        return [entry, ...fillers(45, '2026-10-06T12:30:00Z')];
    }
    // The rest straddle it in time, as on a busy PR.
    const n = Math.max(0, (spec.historySize || 1) - 1);
    return [entry, ...fillers(n, new Date(Date.parse(DECIDED_AT) - Math.floor(n / 2) * 5 * 60e3).toISOString())];
}

const COMMITS = [
    'feat: first cut',
    'test: cover the happy path',
    'address review: rename locals',
    'address review: tighten validation',
    'fix: handle empty input (review)',
    'refactor: extract helper',
    'chore: lint',
];

function rulesFor(spec) {
    if (spec.agent !== 'kody-rules') return undefined;
    const own = spec.rule ? [{ ...spec.rule, path: '**/*', severity: spec.rule.severity || 'high' }] : [];
    const others = TEAM_RULES.filter((r) => !own.some((o) => o.uuid === r.uuid));
    // The case's rule sits among a production-sized set (median 43).
    return [...others.slice(0, 20), ...own, ...others.slice(20)];
}

function build(spec) {
    const common = {
        family: 'rounds',
        repo: spec.head,
        changedFiles: changedFiles(spec),
        sandbox: 'alive',
        commits: commitList(COMMITS, '2026-10-06T09:00:00Z'),
        ...(spec.agent === 'kody-rules' ? { agent: 'kody-rules', kodyRules: rulesFor(spec) } : {}),
        shape: spec.shape,
    };
    const main = { ...common, id: spec.id, previousDecisions: history(spec), claims: spec.claims.map((c) => ({ truth: 'true', ...c })) };
    const control = {
        ...common,
        id: `${spec.id}-control`,
        family: 'control',
        previousDecisions: history({ ...spec, earlier: undefined, historySize: spec.historySize === 'out-of-40' ? 40 : spec.historySize }),
        claims: spec.claims.map((c) => ({
            truth: 'true',
            ...c,
            id: c.id.replace(/repeat/g, 'control'),
            expect: c.expect === 'not_deliver' || c.expect === 'deliver_linked' ? 'deliver' : c.expect,
        })),
    };
    return [main, control];
}

// Checks a spec can measure what it claims (run by check.js and by tests).
function problems(spec) {
    const out = [];
    const files = changedFiles(spec);
    if (!files.length) out.push('no diff between base and head');
    for (const c of spec.claims) {
        if (!/^(deliver|not_deliver|deliver_linked|if_delivered_linked)$/.test(c.expect)) out.push(`${c.id}: bad expect ${c.expect}`);
        if (c.expect === 'not_deliver' && !/repeat/.test(c.id)) out.push(`${c.id}: a must-not-repost claim needs "repeat" in its id`);
        if (!c.at) continue;
        const text = spec.head[c.at.file];
        if (text == null) { out.push(`${c.id}: ${c.at.file} not in head`); continue; }
        const n = text.split('\n').length;
        if (c.at.lines[0] < 1 || c.at.lines[1] > n) out.push(`${c.id}: lines ${c.at.lines} outside ${c.at.file} (${n} lines)`);
        // The rule judge only flags ADDED lines: a claim on unchanged lines
        // would pass for the wrong reason.
        if (spec.agent === 'kody-rules') {
            const f = files.find((x) => x.filename === c.at.file);
            const added = addedLines(f && f.patch);
            const any = Array.from({ length: c.at.lines[1] - c.at.lines[0] + 1 }, (_, i) => c.at.lines[0] + i).some((l) => added.has(l));
            if (!any) out.push(`${c.id}: no added line in ${c.at.file}:${c.at.lines.join('-')} — the rule judge never flags unchanged lines`);
        }
    }
    if (spec.earlier && !spec.head[spec.earlier.file] && !spec.base[spec.earlier.file]) out.push('earlier.file is in neither base nor head');
    return out;
}

module.exports = { build, problems, changedFiles };
