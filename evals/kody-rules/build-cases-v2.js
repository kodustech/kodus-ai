// Build github-cases-v2.json LOCALLY from the frozen github-cases.json fixture.
//
// v1 cases are (PR, single-rule) pairs — GT exists only for that one rule, so
// batched/multi-rule runs left "other-rule flags" unscored. This script:
//   1. dedupes to ONE case per PR,
//   2. enumerates ALL mechanical rules below over every PR's added lines,
//   3. writes groundTruthAll: { ruleUuid: { file: [sites] } } per case.
// No network, no LLM — the GT is a regex over the committed diffs, same
// honesty contract as the original harvester (rule text matches exactly what
// the regex enumerates).
//
//   node evals/kody-rules/build-cases-v2.js
//
// The extended PATTERNS here are the source of truth for the next live
// harvest too (harvest-github-cases.js imports them when present).
const fs = require('fs');
const path = require('path');

// ── extended mechanical rule set (11 rules) ─────────────────────────────────
// Every rule MUST be enumerable by a single-added-line regex, and its `rule`
// text must describe exactly what the regex matches — the model is judged
// against this GT, so any drift between text and regex poisons the metric.
const PATTERNS = {
    'no-direct-process-env': {
        rx: /\bprocess\.env\./,
        title: 'No direct process.env access',
        rule: 'Application code must not read process.env directly. Resolve configuration through the typed config/env module so values are validated and mockable.',
        path: '**/*.{ts,tsx}',
    },
    'no-console': {
        rx: /\bconsole\.(log|warn|error|debug)\s*\(/,
        title: 'No console.* in app code',
        rule: 'Never use console.log/console.error/console.warn/console.debug in application code; use the structured logger.',
        path: '**/*.{ts,tsx}',
    },
    'no-generic-error': {
        rx: /\bthrow new Error\(/,
        title: 'No generic Error — throw a typed error',
        rule: 'Do not `throw new Error(...)` with the generic Error class. Throw a domain-specific error type so callers can discriminate.',
        path: '**/*.{ts,tsx}',
    },
    'no-any-type': {
        rx: /(:\s*any\b|\bas any\b)/,
        title: 'No `any` type',
        rule: 'Do not use the TypeScript `any` type (annotation or `as any` cast). Use a concrete type or `unknown` with narrowing.',
        path: '**/*.{ts,tsx}',
    },
    'no-ts-suppress': {
        rx: /@ts-(ignore|nocheck)\b/,
        title: 'No @ts-ignore / @ts-nocheck',
        rule: 'Do not suppress the TypeScript compiler with `@ts-ignore` or `@ts-nocheck` comments. Fix the type error or use `@ts-expect-error` with a justification.',
        path: '**/*.{ts,tsx}',
    },
    'no-eslint-disable': {
        rx: /eslint-disable/,
        title: 'No eslint-disable comments',
        rule: 'Do not add `eslint-disable` comments (any form: file-level, next-line, or inline). Fix the lint violation instead of silencing it.',
        path: '**/*.{ts,tsx}',
    },
    'no-todo-comment': {
        rx: /(?:\/\/|\/\*)\s*(TODO|FIXME)\b/i,
        title: 'No TODO/FIXME comments',
        rule: 'Do not add TODO or FIXME comments to the codebase. Open a tracked issue instead and reference it, or implement the missing piece.',
        path: '**/*.{ts,tsx}',
    },
    'no-non-null-assertion': {
        rx: /[\w\)\]]!\./,
        title: 'No non-null assertion before member access',
        rule: 'Do not use the non-null assertion operator followed by member access (`foo!.bar`, `arr[i]!.x`, `fn()!.y`). Narrow the type or handle the null case explicitly.',
        path: '**/*.{ts,tsx}',
    },
    'no-deep-relative-import': {
        rx: /from\s+['"](?:\.\.\/){3,}/,
        title: 'No deep relative imports',
        rule: 'Do not import with three or more levels of `../` (e.g. `from "../../../x"`). Use the package/alias import path instead.',
        path: '**/*.{ts,tsx}',
    },
    'no-debugger': {
        rx: /^\s*debugger\s*;?\s*$/,
        title: 'No debugger statements',
        rule: 'Never commit a `debugger` statement (a line consisting solely of `debugger`).',
        path: '**/*.{ts,tsx}',
    },
    'no-skipped-tests': {
        rx: /\b(?:it|test|describe)\.(?:only|skip)\s*\(/,
        title: 'No .only/.skip on tests',
        rule: 'Do not commit `it.only`, `test.only`, `describe.only`, `it.skip`, `test.skip`, or `describe.skip` calls. Focused/skipped tests silently reduce coverage.',
        path: '**/*.{ts,tsx}',
    },
};

// same enumerator as the harvester: added lines only, new-file line numbers
function enumerate(changedFiles, rx) {
    const gt = {};
    for (const f of changedFiles) {
        const sites = [];
        for (const ln of String(f.patchWithLinesStr || '').split('\n')) {
            const m = ln.match(/^\s*(\d+)\s*\+(.*)$/);
            if (m && rx.test(m[2])) sites.push({ line: +m[1], code: m[2].trim().slice(0, 80) });
        }
        if (sites.length) gt[f.filename] = sites;
    }
    return gt;
}

const v1 = require('./github-cases.json');
const byPR = new Map();
for (const c of v1) {
    const prId = c.caseId.split('::')[0];
    if (!byPR.has(prId)) byPR.set(prId, c);
}

const rules = Object.entries(PATTERNS).map(([uuid, spec]) => ({
    uuid, title: spec.title, rule: spec.rule, path: spec.path,
}));

const v2 = [];
for (const [prId, c] of byPR) {
    const groundTruthAll = {};
    let totalSites = 0;
    for (const [uuid, spec] of Object.entries(PATTERNS)) {
        const gt = enumerate(c.realChangedFiles, spec.rx);
        if (Object.keys(gt).length) {
            groundTruthAll[uuid] = gt;
            totalSites += Object.values(gt).reduce((a, b) => a + b.length, 0);
        }
    }
    v2.push({
        caseId: prId,
        source: c.source,
        title: c.title,
        body: c.body || '',
        maxSteps: c.maxSteps || 28,
        realChangedFiles: c.realChangedFiles,
        toolReplay: c.toolReplay,
        rules,
        groundTruthAll,
    });
    const perRule = Object.entries(groundTruthAll)
        .map(([u, gt]) => `${u}=${Object.values(gt).reduce((a, b) => a + b.length, 0)}`)
        .join(' ');
    console.log(`${prId.padEnd(34)} files=${c.realChangedFiles.length} sites=${totalSites}  ${perRule}`);
}

const totSites = v2.reduce((a, c) => a + Object.values(c.groundTruthAll).reduce((x, gt) => x + Object.values(gt).reduce((y, s) => y + s.length, 0), 0), 0);
const totPairs = v2.reduce((a, c) => a + c.realChangedFiles.length * rules.length, 0);
fs.writeFileSync(path.join(__dirname, 'github-cases-v2.json'), JSON.stringify(v2, null, 2));
console.log(`\nWrote ${v2.length} PR cases × ${rules.length} rules → github-cases-v2.json`);
console.log(`total GT sites: ${totSites} (was 43 in v1)   file×rule pairs scored: ${totPairs}`);
module.exports = { PATTERNS };
