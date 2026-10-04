// Stateful reviews: only comments actually delivered become the next round's history.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { once, instrumentVerifier, engineSnapshot } = require('./run');
const { cases } = require('./cases');
const { applyModelEnv } = require('../shared/tier0-models');
const { loadJudgeKey, JUDGE_MODEL } = require('../investigation/recall-judge');
const arg = (name, fallback) =>
    process.argv
        .find((a) => a.startsWith(`--${name}=`))
        ?.slice(name.length + 3) ?? fallback;
const clone = (c) => structuredClone(c);
const byId = (id) => clone(cases.find((c) => c.id.startsWith(id + '-')));

function change(before, after, filename) {
    // Real consecutive snapshots, not a repeated diff from the initial commit.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kody-lifecycle-diff-'));
    fs.writeFileSync(path.join(scratch, 'before'), before);
    fs.writeFileSync(path.join(scratch, 'after'), after);
    let diff;
    try {
        diff = execFileSync(
            'diff',
            ['-U3', path.join(scratch, 'before'), path.join(scratch, 'after')],
            { encoding: 'utf8' },
        );
    } catch (e) {
        if (e.status !== 1) throw e;
        diff = e.stdout;
    } finally {
        fs.rmSync(scratch, { recursive: true });
    }
    return { filename, patch: diff.split('\n').slice(2).join('\n') };
}

function harmless(c, round, file) {
    const next = clone(c);
    const before = c.repo[file];
    next.repo[file] =
        before + `\n// Review commit ${round}: telemetry documentation only.\n`;
    next.changedFiles = [change(before, next.repo[file], file)];
    return next;
}

function sequences() {
    const file = 'src/billing/poller.ts';
    const first = byId('R1');
    delete first.previousDecisions;
    first.claims[0].expect = 'deliver';
    first.changedFiles = [
        change(
            first.repo[file].replace(
                'await gw.submit(charge.payload); // resend',
                '// Wait: this charge is already submitted.',
            ),
            first.repo[file],
            file,
        ),
    ];
    const rejected = [first];
    for (let i = 1; i <= 4; i++) {
        const next = harmless(rejected.at(-1), i, file);
        next.claims[0].expect = 'not_deliver';
        rejected.push(next);
    }
    // A separate real regression in the same PR must still be found after suppression.
    const fresh = byId('R5');
    fresh.repo[file] = rejected.at(-1).repo[file];
    rejected.push(fresh);

    const fixed = [clone(first)];
    const repair = clone(first);
    repair.repo[file] = first.repo[file].replace(
        'await gw.submit(charge.payload); // resend',
        '// Already submitted: wait for the gateway instead of submitting twice.',
    );
    repair.repo[file] = repair.repo[file]
        .replace(
            "return { state: 'resubmitted' as const };",
            "return { state: 'pending' as const };",
        )
        .replace("'billing.resubmit'", "'billing.pending'")
        .replace(
            'NotReadyError means "the gateway never received it": resubmit.',
            'NotReadyError means the gateway is settling the submitted charge: wait.',
        );
    repair.changedFiles = [change(first.repo[file], repair.repo[file], file)];
    repair.claims[0].expect = 'not_deliver';
    fixed.push(repair);
    for (let i = 2; i <= 4; i++) fixed.push(harmless(fixed.at(-1), i, file));

    const partial = byId('R7');
    const http = 'src/http/client.ts';
    const start = clone(partial);
    delete start.previousDecisions;
    start.repo[http] =
        'export async function getJson(url: string) {\n    const res = await fetch(url);\n    if (!res.ok) throw new Error(`HTTP ${res.status}`);\n    return await res.json();\n}\n';
    const bounded = start.repo[http].replace(
        'fetch(url)',
        'fetch(url, { signal: AbortSignal.timeout(5000) })',
    );
    start.changedFiles = [change(bounded, start.repo[http], http)];
    partial.repo[http] = partial.repo[http].replace(
        '        return await res.json();',
        '        if (!res.ok) throw new Error(`HTTP ${res.status}`);\n        return await res.json();',
    );
    start.claims = [
        {
            id: 'timeout-missing',
            golden: 'getJson removes the existing AbortSignal.timeout(5000) from fetch, so requests that previously timed out after five seconds can now hang indefinitely.',
            truth: 'true',
            expect: 'deliver',
        },
    ];
    partial.changedFiles = [change(start.repo[http], partial.repo[http], http)];
    // The developer's fix does not work; the request can still hang — the
    // problem the first comment raised. Already sent: not posted again.
    partial.claims[0].expect = 'not_deliver';
    const refinement = [start, partial];
    for (let i = 2; i <= 4; i++) {
        const next = harmless(refinement.at(-1), i, http);
        next.claims[0].expect = 'not_deliver';
        refinement.push(next);
    }
    return [
        {
            id: 'rejected-four-rounds',
            action: 'Developer rejects as intentional; persisted status remains not_implemented.',
            rounds: rejected,
        },
        {
            id: 'fixed-three-rounds',
            action: 'Developer removes the duplicate submission; persisted status deliberately stays pending.',
            rounds: fixed,
        },
        {
            id: 'refinement-three-rounds',
            action: 'Developer adds an ineffective timeout; the hang the first comment raised is not posted again.',
            rounds: refinement,
        },
    ];
}

async function main() {
    const model = arg('model');
    const reps = Number(arg('reps', '1'));
    const output = arg(
        'output',
        path.join(__dirname, 'results', `lifecycle-${Date.now()}.json`),
    );
    const only = arg('sequence');
    const judgeKey = loadJudgeKey();
    if (!judgeKey || !model) throw new Error('Missing model or judge key');
    applyModelEnv(model);
    instrumentVerifier();
    const engine = engineSnapshot();
    const selected = sequences().filter((s) => !only || s.id === only);
    if (!selected.length) throw new Error('Unknown sequence');
    const runs = [];
    const save = (complete) => {
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(
            output,
            JSON.stringify(
                { model, judge: JUDGE_MODEL, engine, complete, reps, runs },
                null,
                2,
            ),
        );
    };
    save(false);
    for (const sequence of selected)
        for (let rep = 1; rep <= reps; rep++) {
            const history = [];
            const run = {
                sequence: sequence.id,
                action: sequence.action,
                rep,
                rounds: [],
            };
            runs.push(run);
            for (let index = 0; index < sequence.rounds.length; index++) {
                const c = clone(sequence.rounds[index]);
                c.id = `${sequence.id}:round-${index}`;
                c.previousDecisions = clone(history);
                try {
                    const row = await once(c, judgeKey);
                    row.historyBefore = clone(history);
                    row.changedFiles = c.changedFiles;
                    run.rounds.push(row);
                    for (const [i, d] of row.delivered.entries())
                        history.push({
                            suggestionId: `${sequence.id}:${rep}:${index}:${i}`,
                            relevantFile: d.file,
                            relevantLinesStart: Number(d.line),
                            suggestionContent: d.text,
                            label: d.label || 'bug',
                            brokenKodyRulesIds: d.brokenKodyRulesIds,
                            outcome:
                                sequence.id === 'fixed-three-rounds'
                                    ? 'pending'
                                    : 'not_implemented',
                            decidedAt: new Date().toISOString(),
                        });
                    console.log(
                        `${c.id} #${rep}: ${row.claims.map((cl) => `${cl.id}=${cl.pass ? 'PASS' : 'FAIL'}`).join(' ')} delivered=${row.delivered.length} history=${history.length}`,
                    );
                } catch (e) {
                    run.rounds.push({ case: c.id, error: e.message });
                    console.log(`${c.id}: INFRA ${e.message}`);
                    break;
                }
                save(false);
                if (
                    index === 0 &&
                    run.rounds.at(-1)?.claims?.some((cl) => !cl.pass)
                )
                    break;
            }
        }
    save(true);
    const infra = runs.some((r) => r.rounds.some((x) => x.error));
    const failed = runs.some(
        (r) =>
            r.rounds.length !==
                selected.find((s) => s.id === r.sequence).rounds.length ||
            r.rounds.some((x) => x.claims?.some((c) => !c.pass)),
    );
    // Exact acceptance assertions; this is not a calibrated fleet recall floor.
    process.exit(
        infra
            ? 2
            : failed &&
                !(
                    model === 'eval-fake' &&
                    process.argv.includes('--wiring-smoke')
                )
              ? 1
              : 0,
    );
}

module.exports = { sequences, change };
if (require.main === module)
    main().catch((e) => {
        console.error(`INFRA: ${e.stack || e}`);
        process.exit(2);
    });
