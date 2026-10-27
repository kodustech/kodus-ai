#!/usr/bin/env node
// Blind adjudication. Source finding flags and later outcomes are absent.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const zlib = require('node:zlib');

const root = __dirname;
const snapshots = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(root, 'snapshots.json.gz'))),
).cases;
const labelsPath = path.join(root, 'adjudications.json');
const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
const existing = new Set(labels.cases.map((row) => row.id));
const adjudicator = process.argv
    .find((arg) => arg.startsWith('--adjudicator='))
    ?.split('=')[1];
if (!adjudicator) {
    console.error(
        'Usage: node evals/approval-risk/label.js --adjudicator=<your-name>',
    );
    process.exit(2);
}

function nextCase() {
    const counts = new Map();
    for (const row of labels.cases) {
        if (!['hold', 'eligible'].includes(row.decision)) continue;
        const repo = row.id.split('#')[0];
        counts.set(repo, (counts.get(repo) || 0) + 1);
    }
    return snapshots
        .filter(
            (row) =>
                !existing.has(row.id) && (counts.get(row.repository) || 0) < 50,
        )
        .sort(
            (a, b) =>
                (counts.get(a.repository) || 0) -
                    (counts.get(b.repository) || 0) ||
                b.snapshotAt.localeCompare(a.snapshotAt) ||
                a.id.localeCompare(b.id),
        )[0];
}

async function main() {
    const io = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    try {
        while (true) {
            const item = nextCase();
            if (!item) {
                console.log('No unlabeled snapshots remain.');
                break;
            }
            console.log(`\n${item.id} · ${item.title}`);
            console.log(`Snapshot: ${item.snapshotAt} · ${item.headSha}`);
            console.log(`Diff: ${item.compareUrl}`);
            console.log(`Later discussion: ${item.prUrl}`);
            console.log(
                `Files (${item.files.length}): ${item.files.map((file) => file.filename).join(', ')}`,
            );
            console.log(
                item.files
                    .slice(0, 5)
                    .map(
                        (file) =>
                            `\n${file.filename} (+${file.additions}/-${file.deletions})\n${String(file.patch || '[patch unavailable]').slice(0, 3500)}`,
                    )
                    .join('\n')
                    .slice(0, 12000),
            );
            const choice = (
                await io.question(
                    '\nDecision [e]ligible / [h]old / [u]ncertain / [s]kip / [q]uit: ',
                )
            )
                .trim()
                .toLowerCase();
            if (choice === 'q') break;
            if (choice === 's') {
                existing.add(item.id);
                continue;
            }
            const decision = { e: 'eligible', h: 'hold', u: 'uncertain' }[
                choice
            ];
            if (!decision) continue;
            const rationale = (
                await io.question('Rationale (at least 30 characters): ')
            ).trim();
            const evidence =
                (
                    await io.question(`Evidence URL [${item.compareUrl}]: `)
                ).trim() || item.compareUrl;
            if (rationale.length < 30 || !/^https:\/\//.test(evidence)) {
                console.log(
                    'A longer rationale and an HTTPS evidence link are required. This case was not saved.',
                );
                continue;
            }
            labels.cases.push({
                id: item.id,
                decision,
                ...(decision === 'uncertain'
                    ? {}
                    : {
                          snapshotSha: item.headSha,
                          snapshotAt: item.snapshotAt,
                      }),
                adjudicator,
                rationale,
                evidence: [evidence],
            });
            existing.add(item.id);
            fs.writeFileSync(
                labelsPath,
                `${JSON.stringify(labels, null, 2)}\n`,
            );
            console.log(`Saved ${item.id} as ${decision}.`);
        }
    } finally {
        io.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(2);
});
