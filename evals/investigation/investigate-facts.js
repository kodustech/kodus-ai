#!/usr/bin/env node
// Builds the evidence a read-only agent gets when the nightly goes red:
// facts.md (numbers, per-PR changes, the known bugs lost with tonight's and last
// night's findings, the commits measured) and engine.diff (what those commits
// changed in the files finder-recall loads).
//
// Deterministic and cheap. The agent reasons over this plus the repo; it does
// not get raw logs, and it never decides the verdict.
//
//   node evals/investigation/investigate-facts.js --report=<dir> --out=<dir>
//        [--base=<sha>] [--head=<sha>]
//
// <report dir> is the nightly-report artifact: nightly.json,
// nightly.submission.json, last-green/…, commits.tsv, engine-changes.txt.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { compareNights, nightNoise } = require('./nightly-compare');

const MAX_DIFF_BYTES = 200 * 1024;
const MAX_CASES_WITH_FINDINGS = 8;

function flag(name) {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function readLines(file) {
    try {
        return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
        return [];
    }
}

const pct = (v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : 'n/a');
const avg = (xs) => {
    const n = xs.filter((x) => typeof x === 'number');
    return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
};

function findingsByCase(submission) {
    return new Map((submission?.results || []).map((r) => [r.caseId, r.findings || []]));
}

function renderFindings(findings) {
    if (!findings || !findings.length) return '  (no findings)';
    return findings
        .map((f) => `  - ${f.path || '?'}:${f.startLine ?? '?'} [${f.severity || '?'}] ${String(f.description || '').replace(/\s+/g, ' ').slice(0, 400)}`)
        .join('\n');
}

function buildFacts({ tonight, tonightSubmission, lastGreen, lastGreenSubmission, commits, engineChanges, targets }) {
    const comparison = lastGreen ? compareNights(tonight, lastGreen) : null;
    const noise = nightNoise(targets, 'light', tonight.model);
    const gate = tonight.gate || {};
    const rowsNow = new Map((tonight.rows || []).map((r) => [r.caseId, r]));
    const rowsBefore = new Map((lastGreen?.rows || []).map((r) => [r.caseId, r]));
    const findingsNow = findingsByCase(tonightSubmission);
    const findingsBefore = findingsByCase(lastGreenSubmission);
    const out = [];

    out.push('# Nightly finder-recall regression: facts', '');
    out.push(`Model: ${tonight.model} · judge: ${process.env.JUDGE_MODEL || 'see workflow'} · set: light (${tonight.cases} PRs)`);
    out.push(`Gate: ${gate.status} — ${(gate.checks || []).map((c) => `${c.name} ${typeof c.actual === 'number' ? c.actual.toFixed(3) : 'n/a'} (floor ${c.floor}) ${c.pass ? 'ok' : 'BELOW'}`).join('; ')}`);
    if (comparison) {
        out.push(`Recall mean: tonight ${pct(comparison.recall)} vs last green night ${pct(comparison.recallBefore)} (delta ${comparison.recallDelta >= 0 ? '+' : ''}${Math.round(comparison.recallDelta * 100)}pp)`);
        out.push(`Precision mean: tonight ${pct(comparison.precision)} vs ${pct(comparison.precisionBefore)}`);
    } else {
        out.push('No last green night to compare with; only the floor.');
    }
    if (noise) {
        out.push(`Noise: one night's 30-PR mean moves about ±${Math.round(noise * 100)}pp (1σ) with no code change, from two calibration runs. A single PR can swing 50pp+ on its own; judge causes by patterns across PRs, not one PR.`);
    }
    const nowRows = [...rowsNow.values()].filter((r) => r.metadata);
    const beforeRows = [...rowsBefore.values()].filter((r) => r.metadata);
    const collapse = (key) => `${avg(nowRows.map((r) => (key === 'findings' ? r.metadata.tpFindings + r.metadata.fpFindings : r.metadata[key])))?.toFixed?.(1)} vs ${avg(beforeRows.map((r) => (key === 'findings' ? r.metadata.tpFindings + r.metadata.fpFindings : r.metadata[key])))?.toFixed?.(1)}`;
    out.push(`Mean findings per PR: ${collapse('findings')} · mean tool calls: ${collapse('totalCalls')} · replay fidelity: ${collapse('hitRate')}`);
    out.push('');

    out.push('## Commits measured (engine files changed since the last green night)', '');
    out.push(commits.length ? commits.map((c) => `- ${c.sha} ${c.subject} (${c.author})`).join('\n') : '- (none recorded)');
    out.push('', `Changed files finder-recall loads (${engineChanges.length}):`, engineChanges.map((f) => `- ${f}`).join('\n') || '- (none)', '');
    out.push('The diff of those files is in `engine.diff` next to this file.', '');

    if (comparison) {
        out.push('## Per PR (sorted by recall change)', '');
        out.push('| PR | recall before → tonight | findings before → tonight | tool calls before → tonight | known bugs lost | gained |');
        out.push('| --- | --- | --- | --- | --- | --- |');
        for (const c of comparison.perCase) {
            const n = rowsNow.get(c.caseId)?.metadata || {};
            const b = rowsBefore.get(c.caseId)?.metadata || {};
            out.push(`| ${c.caseId} | ${pct(c.recallBefore)} → ${pct(c.recall)} | ${(b.tpFindings ?? 0) + (b.fpFindings ?? 0)} → ${(n.tpFindings ?? 0) + (n.fpFindings ?? 0)} | ${b.totalCalls ?? '?'} → ${n.totalCalls ?? '?'} | ${c.lost ? c.lost.length : 'n/a'} | ${c.gained ? c.gained.length : 'n/a'} |`);
        }
        out.push('');

        out.push('## The PRs that dropped most: known bugs and both nights\' findings', '');
        for (const c of comparison.perCase.filter((x) => x.delta < 0).slice(0, MAX_CASES_WITH_FINDINGS)) {
            out.push(`### ${c.caseId} (${pct(c.recallBefore)} → ${pct(c.recall)})`);
            const goldens = rowsNow.get(c.caseId)?.metadata?.goldenResults;
            if (c.lost && c.lost.length) out.push('Known bugs found last green night, missed tonight:', ...c.lost.map((g) => `  - ${g}`));
            else if (goldens) out.push('Known bugs and whether tonight found them:', ...goldens.map((g) => `  - [${g.found ? 'found' : 'missed'}] ${g.golden}`));
            out.push('Last green night findings:', renderFindings(findingsBefore.get(c.caseId)));
            out.push('Tonight findings:', renderFindings(findingsNow.get(c.caseId)), '');
        }
    }
    return out.join('\n');
}

function engineDiff(base, head, files) {
    if (!base || !head || !files.length) return '(no base commit or no changed engine files: nothing to diff)\n';
    try {
        const diff = execFileSync('git', ['diff', '--no-color', base, head, '--', ...files], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        return diff.length > MAX_DIFF_BYTES ? `${diff.slice(0, MAX_DIFF_BYTES)}\n\n[diff truncated at ${MAX_DIFF_BYTES / 1024}KB of ${Math.round(diff.length / 1024)}KB; read the files in the repo for the rest]\n` : diff;
    } catch (error) {
        return `(git diff failed: ${error.message})\n`;
    }
}

function main() {
    const report = flag('report');
    const outDir = flag('out');
    if (!report || !outDir) {
        console.error('usage: node evals/investigation/investigate-facts.js --report=<dir> --out=<dir> [--base=<sha>] [--head=<sha>]');
        return 2;
    }
    const tonight = readJson(path.join(report, 'nightly.json'));
    if (!tonight) {
        console.error(`no nightly.json in ${report}`);
        return 2;
    }
    const engineChanges = readLines(path.join(report, 'engine-changes.txt'));
    const commits = readLines(path.join(report, 'commits.tsv')).map((line) => {
        const [sha, subject, author] = line.split('\t');
        return { sha, subject, author };
    });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
        path.join(outDir, 'facts.md'),
        buildFacts({
            tonight,
            tonightSubmission: readJson(path.join(report, 'nightly.submission.json')),
            lastGreen: readJson(path.join(report, 'last-green', 'nightly.json')),
            lastGreenSubmission: readJson(path.join(report, 'last-green', 'nightly.submission.json')),
            commits,
            engineChanges,
            targets: readJson(path.join(__dirname, 'targets.json')),
        }),
    );
    fs.writeFileSync(path.join(outDir, 'engine.diff'), engineDiff(flag('base'), flag('head'), engineChanges));
    console.log(`evidence written to ${outDir}: facts.md, engine.diff`);
    return 0;
}

module.exports = { buildFacts };

if (require.main === module) process.exit(main());
