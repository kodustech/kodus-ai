// Generate kody-rules cases from REAL benchmark PR diffs.
//
// Instead of hand-authored toy snippets, we take the real, heavy changedFiles +
// real toolReplay already extracted into evals/investigation/datasets, define a
// rule whose target pattern genuinely occurs in those diffs, and compute the
// ground truth by ENUMERATING the real occurrences (added lines matching the
// pattern). The rule is ours; the violations are real and verifiable.
//
//   node evals/kody-rules/build-bench-cases.js   → writes bench-cases.json
//
// real-agent.js --dataset=bench-cases then runs the real engine over them.
const fs = require('fs');
const path = require('path');

const DS_DIR = path.join(__dirname, '../../evals/investigation/datasets');

function loadDataset(name) {
    const cd = JSON.parse(fs.readFileSync(path.join(DS_DIR, `${name}.json`), 'utf8'))[0];
    const v = cd.vars;
    const changedFiles = typeof v.changedFiles === 'string' ? JSON.parse(v.changedFiles) : v.changedFiles;
    const toolReplay = typeof v.toolReplay === 'string' ? JSON.parse(v.toolReplay) : v.toolReplay;
    return { prTitle: v.prTitle, prBody: v.prBody, changedFiles, toolReplay };
}

// Enumerate files whose ADDED lines (NN +code) match the rule pattern.
function violatingFiles(changedFiles, rx) {
    const hits = {};
    for (const f of changedFiles) {
        const sites = [];
        for (const ln of String(f.patchWithLinesStr || f.patch || '').split('\n')) {
            const m = ln.match(/^\s*(\d+)\s*\+(.*)$/);
            if (m && rx.test(m[2])) sites.push({ line: +m[1], code: m[2].trim().slice(0, 80) });
        }
        if (sites.length) hits[f.filename] = sites;
    }
    return hits;
}

// (dataset, rule, detector) → real occurrences become ground truth.
const SPECS = [
    {
        dataset: 'feat-2fa-backup-codes-cal-com',
        rule: { uuid: 'no-direct-process-env', title: 'No direct process.env access', rule: 'Application code must not read process.env directly. Resolve configuration through the typed config/env module so values are validated and mockable. Applies to all TypeScript source.', path: '**/*.{ts,tsx}' },
        detector: /\bprocess\.env\./,
    },
    {
        dataset: 'feat-2fa-backup-codes-cal-com',
        rule: { uuid: 'no-console-2fa', title: 'No console.* in app code', rule: 'Never use console.log/console.error/console.warn/console.debug in application code; use the structured logger so logs are captured and leveled.', path: '**/*.{ts,tsx}' },
        detector: /\bconsole\.(log|warn|error|debug)\s*\(/,
    },
    {
        dataset: 'feat-2fa-backup-codes-cal-com',
        rule: { uuid: 'no-generic-error', title: 'No generic Error — throw a typed error', rule: 'Do not `throw new Error(...)` with the generic Error class. Throw a domain-specific error type (e.g. HttpError, ValidationError) so callers can discriminate. Applies to TypeScript source.', path: '**/*.{ts,tsx}' },
        detector: /\bthrow new Error\(/,
    },
];

const cases = [];
for (const spec of SPECS) {
    const ds = loadDataset(spec.dataset);
    const hits = violatingFiles(ds.changedFiles, spec.detector);
    const vFiles = Object.keys(hits);
    if (!vFiles.length) { console.warn(`! ${spec.rule.uuid}: no real occurrences in ${spec.dataset} — skipped`); continue; }
    cases.push({
        caseId: `${spec.dataset}::${spec.rule.uuid}`,
        rule: spec.rule,
        title: ds.prTitle,
        body: (ds.prBody || '').slice(0, 600),
        maxSteps: 26,
        // REAL heavy diff + REAL recorded tool outputs.
        realChangedFiles: ds.changedFiles,
        toolReplay: ds.toolReplay,
        // ground truth: violating = files with a real matching added line; the
        // rest of the changed files are clean controls (must not be flagged).
        violatingFiles: vFiles,
        cleanFiles: ds.changedFiles.map((f) => f.filename).filter((fn) => !vFiles.includes(fn)),
        groundTruth: hits,
    });
    console.log(`✓ ${spec.rule.uuid.padEnd(22)} ${vFiles.length} violating / ${ds.changedFiles.length} files`);
    for (const fn of vFiles) console.log(`    ${fn.split('/').slice(-2).join('/')}  ${hits[fn].map((h) => h.line).join(',')}`);
}

fs.writeFileSync(path.join(__dirname, 'bench-cases.json'), JSON.stringify(cases, null, 2));
console.log(`\nWrote ${cases.length} bench cases → evals/kody-rules/bench-cases.json`);
