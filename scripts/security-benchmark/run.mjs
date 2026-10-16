#!/usr/bin/env node
/**
 * Runs analyzers over the security dataset and scores them.
 *
 * Deliberately offline: samples carry their own diffs, so this needs no
 * network, no forks, no Kody run, and no MongoDB. A full pass is seconds,
 * which is what makes it usable as a gate while iterating on a rule pack.
 *
 * Scoring:
 *   vuln sample  — a finding on one of the `expected` lines is a true positive.
 *                  Anything else in that sample is a false positive.
 *   noise sample — every finding is a false positive by construction.
 *
 * Findings are clipped to lines the diff ADDS before scoring, matching how the
 * review pipeline treats analyzer output.
 *
 * Usage: node run.mjs <dataset.json> --tool <cmd-template> [--name N] [--json out]
 *   The template receives {dir} (the tree to scan) and optionally {out} (a
 *   SARIF path to write). Use {out} for tools that cannot write to stdout —
 *   opengrep silently produces nothing for `--output /dev/stdout`.
 */
import { execFile } from 'node:child_process';
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    rmSync,
    readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Line numbers a patch adds, on the new side. */
function addedLines(patch) {
    const set = new Set();
    let cursor = 0;
    for (const line of patch.split('\n')) {
        const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            cursor = parseInt(hunk[1], 10);
            continue;
        }
        if (line.startsWith('+')) {
            set.add(cursor);
            cursor++;
        } else if (line.startsWith('-')) {
            // old side only
        } else {
            cursor++;
        }
    }
    return set;
}

/** Reconstructs the post-change file content from a patch. */
function applyPatch(patch) {
    const out = [];
    for (const line of patch.split('\n')) {
        if (line.startsWith('@@')) continue;
        if (line.startsWith('-')) continue;
        if (line.startsWith('+')) out.push(line.slice(1));
        else if (line.startsWith('\\')) continue;
        else out.push(line.startsWith(' ') ? line.slice(1) : line);
    }
    return out.join('\n');
}

function materialize(sample, root) {
    const dir = join(root, sample.id);
    for (const file of sample.files) {
        const dest = join(dir, file.path);
        mkdirSync(dirname(dest), { recursive: true });
        // Prefer the stored full file: its line numbers are the real ones and
        // it actually parses. Patch reconstruction is a fallback for samples
        // whose files are wholly added (the noise tranche), where the patch
        // covers the file from line 1 and reconstruction is exact.
        writeFileSync(dest, file.content ?? applyPatch(file.patch));
    }
    return dir;
}

function parseSarif(text) {
    let sarif;
    try {
        sarif = JSON.parse(text);
    } catch {
        return [];
    }
    const findings = [];
    for (const run of sarif.runs ?? []) {
        for (const result of run.results ?? []) {
            const loc = result.locations?.[0]?.physicalLocation;
            if (!loc) continue;
            findings.push({
                rule: (result.ruleId ?? 'unknown').replace(/^.*?\brules\./, ''),
                path: decodeURIComponent(loc.artifactLocation?.uri ?? '').replace(
                    /^file:\/\//,
                    '',
                ),
                line: loc.region?.startLine ?? 0,
            });
        }
    }
    return findings;
}

async function main() {
    const [datasetPath] = process.argv.slice(2);
    const toolIndex = process.argv.indexOf('--tool');
    const nameIndex = process.argv.indexOf('--name');
    const jsonIndex = process.argv.indexOf('--json');

    if (!datasetPath || toolIndex === -1) {
        console.error(
            'usage: run.mjs <dataset.json> --tool "<cmd with {dir}>" [--name N] [--json out]',
        );
        process.exit(1);
    }

    const template = process.argv[toolIndex + 1];
    const toolName = nameIndex === -1 ? 'tool' : process.argv[nameIndex + 1];
    const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));

    const root = mkdtempSync(join(tmpdir(), 'secbench-'));
    const perSample = [];

    try {
        for (const sample of dataset.samples) {
            materialize(sample, root);
        }

        // One invocation over every sample. Rule loading dominates analyzer
        // runtime (~10s for a broad pack, ~1s to scan), so invoking per sample
        // would measure startup cost 70 times over instead of detection.
        const sarifPath = join(root, '__report.sarif');
        const command = template
            .replace('{dir}', root)
            .replace('{out}', sarifPath);

        let stdout = '';
        try {
            ({ stdout } = await execFileP('bash', ['-lc', command], {
                maxBuffer: 256 * 1024 * 1024,
            }));
        } catch (error) {
            // Most scanners exit non-zero when they find something.
            stdout = error.stdout ?? '';
        }

        let report = stdout;
        if (existsSync(sarifPath)) {
            report = readFileSync(sarifPath, 'utf8');
        }

        const bySample = new Map();
        for (const finding of parseSarif(report)) {
            const relative = finding.path.replace(`${root}/`, '');
            const slash = relative.indexOf('/');
            if (slash === -1) continue;
            const id = relative.slice(0, slash);
            const path = relative.slice(slash + 1);
            if (!bySample.has(id)) bySample.set(id, []);
            bySample.get(id).push({ ...finding, path });
        }

        for (const sample of dataset.samples) {
            const addedByFile = new Map(
                sample.files.map((f) => [f.path, addedLines(f.patch)]),
            );
            const expectedByFile = new Map(
                (sample.expected ?? []).map((e) => [e.path, new Set(e.lines)]),
            );

            const inDiff = (bySample.get(sample.id) ?? []).filter((f) =>
                addedByFile.get(f.path)?.has(f.line),
            );

            const truePositives = inDiff.filter((f) =>
                expectedByFile.get(f.path)?.has(f.line),
            );
            const falsePositives = inDiff.filter(
                (f) => !expectedByFile.get(f.path)?.has(f.line),
            );
            const fileLevelHit =
                sample.tranche === 'vuln' &&
                inDiff.some((f) => expectedByFile.has(f.path));

            perSample.push({
                id: sample.id,
                tranche: sample.tranche,
                cweLabel: sample.cweLabel ?? sample.trap ?? null,
                language: sample.language,
                findings: inDiff.length,
                truePositives: truePositives.length,
                falsePositives: falsePositives.length,
                detected: truePositives.length > 0,
                fileLevelHit,
                rules: [...new Set(inDiff.map((f) => f.rule))],
            });
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }

    const vuln = perSample.filter((s) => s.tranche === 'vuln');
    const noise = perSample.filter((s) => s.tranche === 'noise');

    const detected = vuln.filter((s) => s.detected).length;
    const recall = vuln.length === 0 ? 0 : detected / vuln.length;

    // Precision comes from the noise tranche ALONE. On a vulnerability sample
    // `expected` is every added source line, so any in-diff finding there
    // scores as a hit by construction — a ratio computed across both tranches
    // would be guaranteed-high and meaningless.
    const noiseFindings = noise.reduce((n, s) => n + s.findings, 0);
    const cleanNoise = noise.filter((s) => s.findings === 0).length;
    const noiseCleanRate = noise.length === 0 ? 0 : cleanNoise / noise.length;

    const vulnFindings = vuln.reduce((n, s) => n + s.findings, 0);
    const pct = (n) => `${(n * 100).toFixed(1)}%`;

    console.log(`\n=== ${toolName} ===`);
    console.log(`RECALL   vulnerabilities flagged : ${detected}/${vuln.length}  (${pct(recall)})`);
    console.log(`PRECISION noise samples clean    : ${cleanNoise}/${noise.length}  (${pct(noiseCleanRate)})`);
    console.log(`          false findings on noise: ${noiseFindings}`);
    console.log(`VERBOSITY findings per vuln PR   : ${(vulnFindings / Math.max(1, vuln.length)).toFixed(2)}`);

    const byClass = new Map();
    for (const s of vuln) {
        const key = s.cweLabel ?? 'unknown';
        const row = byClass.get(key) ?? { total: 0, detected: 0 };
        row.total++;
        if (s.detected) row.detected++;
        byClass.set(key, row);
    }
    console.log('\nby vulnerability class:');
    for (const [label, row] of [...byClass].sort((a, b) => b[1].detected - a[1].detected)) {
        console.log(
            `  ${String(row.detected).padStart(2)}/${String(row.total).padEnd(2)}  ${label}`,
        );
    }

    // Which rules earned the detections. Worth reading: a maintainability rule
    // landing on a vulnerable line counts as a hit here but is not a real
    // detection, and only this list makes that visible.
    const creditedRules = new Map();
    for (const s of vuln.filter((x) => x.detected)) {
        for (const rule of s.rules) {
            creditedRules.set(rule, (creditedRules.get(rule) ?? 0) + 1);
        }
    }
    if (creditedRules.size) {
        console.log('\nrules credited with a detection:');
        for (const [rule, n] of [...creditedRules].sort((a, b) => b[1] - a[1])) {
            console.log(`  ${String(n).padStart(2)}  ${rule}`);
        }
    }

    const noisy = noise.filter((s) => s.findings > 0);
    if (noisy.length) {
        console.log(`\nfalse positives on noise (${noisy.length}):`);
        for (const s of noisy) {
            console.log(`  - ${s.id}  ${s.findings}: ${s.rules.join(', ')}`);
        }
    }

    if (jsonIndex !== -1) {
        writeFileSync(
            process.argv[jsonIndex + 1],
            JSON.stringify(
                {
                    tool: toolName,
                    summary: {
                        detected,
                        vuln: vuln.length,
                        recall,
                        cleanNoise,
                        noiseSamples: noise.length,
                        noiseFindings,
                        findingsPerVulnSample: vulnFindings / Math.max(1, vuln.length),
                    },
                    perSample,
                },
                null,
                2,
            ),
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
