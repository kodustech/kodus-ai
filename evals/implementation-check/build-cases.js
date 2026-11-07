#!/usr/bin/env node
// Builds cases.json from sources.js: each edit applied to the real file it
// names, and the change since the last review turned into the patch GitHub
// returns for it (hunks only, no file header).
//
//   node evals/implementation-check/build-cases.js [--check]
//
// --check exits 1 when cases.json is not what sources.js builds.
const fs = require('fs');
const path = require('path');
const { structuredPatch } = require('diff');
const { SUGGESTIONS, KINDS, MULTI, KEEPS } = require('./sources');

const DATASETS = path.join(__dirname, '../investigation/datasets');
const OUT = path.join(__dirname, 'cases.json');

function fileAtHead(dataset, file) {
    const [record] = JSON.parse(fs.readFileSync(path.join(DATASETS, `${dataset}.json`), 'utf8'));
    const reads = JSON.parse(record.vars.toolReplay).readFile || [];
    const hit = reads.find((r) => r.match.path === file);
    if (typeof hit?.result !== 'string') throw new Error(`${dataset}: no ${file} at the PR head`);
    return hit.result;
}

function applyEdits(content, edits, where) {
    return edits.reduce((text, [find, replace]) => {
        if (typeof text !== 'string' || typeof find !== 'string') throw new Error(`${where}: an edit is not text`);
        const at = text.indexOf(find);
        if (at === -1 || text.indexOf(find, at + 1) !== -1) {
            throw new Error(`${where}: the edit must match exactly once: ${JSON.stringify(find.slice(0, 80))}`);
        }
        return text.slice(0, at) + replace + text.slice(at + find.length);
    }, content);
}

// GitHub's `patch` for one file: its hunks, three lines of context.
function githubPatch(before, after) {
    const { hunks } = structuredPatch('a', 'b', before, after, '', '', { context: 3 });
    return hunks
        .map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n'))
        .join('\n');
}

function savedSuggestion(id, stored = 'not_implemented') {
    const s = SUGGESTIONS[id];
    return {
        id: `sugg-${id}`,
        relevantFile: s.file,
        language: s.language,
        label: s.label,
        severity: s.severity,
        oneSentenceSummary: s.summary,
        suggestionContent: s.content,
        fullExplanation: s.content,
        existingCode: s.existingCode,
        improvedCode: s.improvedCode,
        relevantLinesStart: s.lines[0],
        relevantLinesEnd: s.lines[1],
        ...(s.kodyRule ? { brokenKodyRulesIds: [s.kodyRule] } : {}),
        deliveryStatus: 'sent',
        implementationStatus: stored,
    };
}

function kindOf(id) {
    const s = SUGGESTIONS[id];
    if (s.kodyRule) return 'kody-rule';
    return s.improvedCode ? 'with-fix' : 'without-fix';
}

// Applies each part's edit to its file; parts on one file stack.
function changedFiles(parts, base = {}) {
    const byFile = new Map();
    for (const [id, edit] of parts) {
        const s = SUGGESTIONS[id];
        const original = byFile.get(s.file)?.before ?? applyEdits(fileAtHead(s.dataset, s.file), base[id] || [], `${id}/base`);
        const current = byFile.get(s.file)?.after ?? original;
        byFile.set(s.file, { before: original, after: applyEdits(current, s.edits[edit], `${id}/${edit}`) });
    }
    return [...byFile].map(([filename, { before, after }]) => ({ filename, status: 'modified', patch: githubPatch(before, after) }));
}

function build() {
    const cases = [];
    for (const [id, s] of Object.entries(SUGGESTIONS)) {
        for (const edit of Object.keys(s.edits)) {
            cases.push({
                id: `${id}-${edit}`,
                checks: `${s.language} ${kindOf(id)} suggestion: ${KINDS[edit].checks}`,
                kind: kindOf(id),
                edit,
                suggestions: [savedSuggestion(id)],
                changedFiles: changedFiles([[id, edit]]),
                expected: { [`sugg-${id}`]: KINDS[edit].expected },
            });
        }
    }
    for (const m of MULTI) {
        cases.push({
            id: m.id,
            checks: `Several suggestions in one check: ${m.checks}`,
            kind: 'multi',
            edit: 'multi',
            suggestions: m.parts.map(([id]) => savedSuggestion(id)),
            changedFiles: changedFiles(m.parts),
            expected: Object.fromEntries(m.parts.map(([id, edit]) => [`sugg-${id}`, KINDS[edit].expected])),
        });
    }
    for (const k of KEEPS) {
        const s = SUGGESTIONS[k.suggestion];
        cases.push({
            id: k.id,
            checks: `${s.language} suggestion: ${k.checks}`,
            kind: kindOf(k.suggestion),
            edit: 'keeps',
            suggestions: [savedSuggestion(k.suggestion, k.stored)],
            changedFiles: changedFiles([[k.suggestion, k.edit]], { [k.suggestion]: s.edits[k.base] }),
            expected: { [`sugg-${k.suggestion}`]: k.stored },
        });
    }
    return cases;
}

if (require.main === module) {
    const text = `${JSON.stringify(build(), null, 2)}\n`;
    if (process.argv.includes('--check')) {
        const same = fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === text;
        if (!same) console.error('cases.json is stale: run node evals/implementation-check/build-cases.js');
        process.exit(same ? 0 : 1);
    }
    fs.writeFileSync(OUT, text);
    console.log(`wrote ${JSON.parse(text).length} cases to ${path.relative(process.cwd(), OUT)}`);
}

module.exports = { build };
