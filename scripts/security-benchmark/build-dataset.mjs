#!/usr/bin/env node
/**
 * Builds the security benchmark dataset.
 *
 * The existing 50-PR benchmark is a LOGIC-bug corpus: it contains no secrets
 * and no vulnerable dependencies, so it cannot score a deterministic security
 * analyzer at all. This builds the corpus that can.
 *
 * Construction: take a published advisory's FIX commit and invert its patch.
 * The resulting diff INTRODUCES the vulnerability as added lines — the exact
 * shape a reviewer sees on a pull request, and the shape diff-clipping needs.
 * Diffs are stored inline so the dataset stays reproducible when upstream
 * repositories rewrite history, go private, or disappear.
 *
 * Usage: node build-dataset.mjs <out.json> [--limit N] [--per-cwe N]
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { NOISE_SAMPLES } from './noise-samples.mjs';

const execFileP = promisify(execFile);

/**
 * CWEs a pattern-matching analyzer can plausibly detect. Deliberately excludes
 * classes that need whole-program reasoning (race conditions, auth logic
 * errors) — those belong to the LLM reviewer, and seeding them here would
 * measure the wrong thing.
 */
const TARGET_CWES = [
    { cwe: 78, label: 'command injection' },
    { cwe: 79, label: 'cross-site scripting' },
    { cwe: 89, label: 'SQL injection' },
    { cwe: 22, label: 'path traversal' },
    { cwe: 918, label: 'server-side request forgery' },
    { cwe: 502, label: 'unsafe deserialization' },
    { cwe: 798, label: 'hardcoded credentials' },
    { cwe: 327, label: 'broken or risky cryptography' },
    { cwe: 94, label: 'code injection' },
    { cwe: 611, label: 'XML external entity' },
];

const SOURCE_EXTENSIONS = new Map([
    ['.py', 'python'],
    ['.js', 'javascript'],
    ['.jsx', 'javascript'],
    ['.ts', 'typescript'],
    ['.tsx', 'typescript'],
    ['.rb', 'ruby'],
    ['.go', 'go'],
    ['.java', 'java'],
    ['.php', 'php'],
    ['.rs', 'rust'],
    ['.cs', 'csharp'],
    ['.c', 'c'],
    ['.cc', 'cpp'],
    ['.cpp', 'cpp'],
    ['.scala', 'scala'],
    ['.kt', 'kotlin'],
    ['.ex', 'elixir'],
]);

/** A fix that adds a whole new module is a rewrite, not a clean sample. */
const MAX_CHANGED_LINES = 120;
const MAX_FILES = 8;

const ghRaw = async (path) => {
    const { stdout } = await execFileP(
        'gh',
        ['api', path, '-H', 'Accept: application/vnd.github.raw'],
        { maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout;
};

const gh = async (path) => {
    const { stdout } = await execFileP('gh', ['api', path], {
        maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(stdout);
};

const extensionOf = (filename) => {
    const dot = filename.lastIndexOf('.');
    return dot === -1 ? '' : filename.slice(dot).toLowerCase();
};

const isSource = (filename) => {
    if (/(^|\/)(test|tests|spec|__tests__|fixtures?|examples?|docs?)\//i.test(filename)) {
        return false;
    }
    if (/[._-](test|spec)\.[a-z]+$/i.test(filename)) return false;
    return SOURCE_EXTENSIONS.has(extensionOf(filename));
};

/**
 * Reverses a unified diff: the fix becomes the change that introduces the
 * vulnerability. Hunk headers swap their old/new ranges; +/- lines swap.
 * GitHub's `patch` field starts at the first @@, so there are no ---/+++
 * file headers to worry about.
 */
export function invertPatch(patch) {
    return patch
        .split('\n')
        .map((line) => {
            const hunk = line.match(
                /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/,
            );
            if (hunk) {
                const [, oldStart, oldLen, newStart, newLen, rest] = hunk;
                const oldRange =
                    oldLen === undefined ? oldStart : `${oldStart},${oldLen}`;
                const newRange =
                    newLen === undefined ? newStart : `${newStart},${newLen}`;
                return `@@ -${newRange} +${oldRange} @@${rest}`;
            }
            if (line.startsWith('+')) return `-${line.slice(1)}`;
            if (line.startsWith('-')) return `+${line.slice(1)}`;
            return line;
        })
        .join('\n');
}

/** Line numbers a patch ADDS, on the new side. */
export function addedLines(patch) {
    const lines = [];
    let cursor = 0;
    for (const line of patch.split('\n')) {
        const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            cursor = parseInt(hunk[1], 10);
            continue;
        }
        if (line.startsWith('+')) {
            lines.push(cursor);
            cursor++;
        } else if (line.startsWith('-')) {
            // present only on the old side
        } else {
            cursor++;
        }
    }
    return lines;
}

const commitRefs = (advisory) =>
    (advisory.references ?? [])
        .map((url) =>
            url.match(
                /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})/,
            ),
        )
        .filter(Boolean)
        .map((m) => ({ repo: `${m[1]}/${m[2]}`, sha: m[3] }));

async function buildSample(advisory, ref, cweLabel) {
    let commit;
    try {
        commit = await gh(`repos/${ref.repo}/commits/${ref.sha}`);
    } catch {
        return null;
    }

    const files = (commit.files ?? []).filter((f) => f.patch);
    if (files.length === 0 || files.length > MAX_FILES) return null;

    const changed = files.reduce(
        (sum, f) => sum + (f.additions ?? 0) + (f.deletions ?? 0),
        0,
    );
    if (changed > MAX_CHANGED_LINES) return null;

    const sourceFiles = files.filter((f) => isSource(f.filename));
    if (sourceFiles.length === 0) return null;

    // The vulnerable file is the fix commit's PARENT. Store it in full:
    // reconstructing a file from hunks alone shifts every line number and
    // produces something no parser will accept, so an analyzer would either
    // skip it or report unusable positions.
    const parentSha = commit.parents?.[0]?.sha;
    if (!parentSha) return null;

    const inverted = [];
    for (const f of files) {
        const entry = { path: f.filename, patch: invertPatch(f.patch) };
        if (isSource(f.filename)) {
            try {
                entry.content = await ghRaw(
                    `repos/${ref.repo}/contents/${encodeURI(f.filename)}?ref=${parentSha}`,
                );
            } catch {
                return null;
            }
        }
        inverted.push(entry);
    }

    // Vulnerable lines = what the fix removed = what the inverted diff adds.
    const expected = inverted
        .filter((f) => isSource(f.path))
        .map((f) => ({ path: f.path, lines: addedLines(f.patch) }))
        .filter((f) => f.lines.length > 0);

    if (expected.length === 0) return null;

    const language =
        SOURCE_EXTENSIONS.get(extensionOf(sourceFiles[0].filename)) ?? 'unknown';

    return {
        id: advisory.ghsa_id,
        tranche: 'vuln',
        source: {
            advisory: advisory.ghsa_id,
            cve: advisory.cve_id ?? null,
            repo: ref.repo,
            fixCommit: ref.sha,
            vulnerableCommit: parentSha,
            url: advisory.html_url,
        },
        cwes: (advisory.cwes ?? []).map((c) => c.cwe_id),
        cweLabel,
        severity: advisory.severity,
        language,
        summary: advisory.summary,
        expected,
        golden_comments: [
            {
                comment: `${cweLabel}: ${advisory.summary}`,
                severity:
                    advisory.severity === 'critical'
                        ? 'Critical'
                        : advisory.severity === 'high'
                          ? 'High'
                          : advisory.severity === 'moderate'
                            ? 'Medium'
                            : 'Low',
            },
        ],
        files: inverted,
    };
}

async function main() {
    const out = process.argv[2];
    if (!out) {
        console.error('usage: build-dataset.mjs <out.json> [--per-cwe N]');
        process.exit(1);
    }
    const perCweIndex = process.argv.indexOf('--per-cwe');
    const perCwe = perCweIndex === -1 ? 4 : Number(process.argv[perCweIndex + 1]);

    const samples = [];
    const seenRepoCommit = new Set();

    for (const { cwe, label } of TARGET_CWES) {
        let advisories = [];
        try {
            advisories = await gh(
                `/advisories?type=reviewed&cwes=${cwe}&per_page=100`,
            );
        } catch (e) {
            console.error(`  CWE-${cwe}: query failed — ${e.message.slice(0, 80)}`);
            continue;
        }

        let kept = 0;
        for (const advisory of advisories) {
            if (kept >= perCwe) break;
            for (const ref of commitRefs(advisory)) {
                const key = `${ref.repo}@${ref.sha}`;
                if (seenRepoCommit.has(key)) continue;
                const sample = await buildSample(advisory, ref, label);
                if (!sample) continue;
                seenRepoCommit.add(key);
                samples.push(sample);
                kept++;
                break;
            }
        }
        console.log(`CWE-${cwe} (${label}): ${kept} samples`);
    }

    const all = [...samples, ...NOISE_SAMPLES];

    writeFileSync(
        out,
        JSON.stringify(
            {
                version: 1,
                generatedAt: new Date().toISOString(),
                counts: {
                    vuln: samples.length,
                    noise: NOISE_SAMPLES.length,
                },
                samples: all,
            },
            null,
            2,
        ),
    );
    console.log(
        `\nwrote ${samples.length} vulnerability + ${NOISE_SAMPLES.length} noise samples → ${out}`,
    );
}

if (process.argv[1]?.endsWith('build-dataset.mjs')) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
