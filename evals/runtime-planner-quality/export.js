#!/usr/bin/env node
// Exports what Kody Runtime's planner and recipe author did on the kr-* test
// repositories, read-only, from the Runtime Postgres: per Run the diff it was
// given, the entry points, the plan it submitted, how long planning took and
// what the replay measured; per setup the recipe author's outcome and the boot
// that followed. run.js scores the file this writes.
//
// It runs where the Runtime database is reachable and the `pg` package
// resolves, e.g. inside the hub container:
//
//   docker exec -i -e SINCE_DAYS=7 kodus_runtime_hub node - < evals/runtime-planner-quality/export.js > traces.json
//
// RUNTIME_DATABASE_URL comes from the container's environment; the session is
// read-only. Only repositories named kr-* are exported, and organization and
// team ids are left out. The file stays outside the repository (Run ids,
// timings): run.js reads it from --traces.
//
// Run in the worker container instead (kodus_runtime_worker), where the
// evidence store's volume is (RUNTIME_EVIDENCE_DIR), and each replay round
// whose body is not JSON also carries that body as the worker kept it
// (redacted, at most 1 MiB) and its content type, so `run.js --regate` can
// derive its compared fields again with the current code.
const fs = require('fs');
const path = require('path');
const { Client } = require(require.resolve('pg', { paths: [process.cwd()] }));

const SINCE_DAYS = Math.max(1, Number(process.env.SINCE_DAYS) || 7);
/** Bytes of a changed file's content kept: what the entry-point extractor reads (extract.ts MAX_CONTENT_CHARS). */
const CONTENT_CHARS = 128 * 1024;
const PATCH_CHARS = 60_000;
const REPO = /(^|\/)kr-[\w.-]+$/;
const EVIDENCE_DIR = process.env.RUNTIME_EVIDENCE_DIR;

/** The organization folders of the evidence store (never exported: only used to find a step's output). */
const evidenceOrgs = () => {
    try {
        return EVIDENCE_DIR
            ? fs
                  .readdirSync(EVIDENCE_DIR)
                  .filter((d) =>
                      fs.statSync(path.join(EVIDENCE_DIR, d)).isDirectory(),
                  )
            : [];
    } catch {
        return [];
    }
};
/** A replay round's HTTP answer as the worker's step output evidence kept it ({org}/{run}/{side}/{stepId}/output). */
function recordedResponse(orgs, runId, side, stepId) {
    for (const org of orgs) {
        const file = path.join(
            EVIDENCE_DIR,
            org,
            runId,
            side,
            String(stepId),
            'output',
        );
        if (!fs.existsSync(file)) continue;
        try {
            const http = JSON.parse(fs.readFileSync(file, 'utf8')).result?.http;
            if (!http || typeof http.body !== 'string') return null;
            const type = Object.entries(http.headers || {}).find(
                ([k]) => k.toLowerCase() === 'content-type',
            )?.[1];
            return { contentType: type ?? null, body: http.body };
        } catch {
            return null;
        }
    }
    return null;
}

const parse = (s) => {
    try {
        const v = JSON.parse(s);
        return v && v.json !== undefined ? v.json : v;
    } catch {
        return null;
    }
};
const statusOf = (lane) => {
    const e = (lane?.events || []).find((x) => x.kind === 'response');
    const m = /status (\d+)/.exec(e?.label || '');
    return m ? Number(m[1]) : null;
};

async function runs(c) {
    const orgs = evidenceOrgs();
    const rows = (
        await c.query(
            `select run_id, repository_name, pr_number, head_sha, base_sha, state, verdict_state, requested_at, finished_at, report
             from runtime.runtime_runs where requested_at > now() - make_interval(days => $1) order by requested_at`,
            [SINCE_DAYS],
        )
    ).rows.filter((r) => REPO.test(r.repository_name));
    const out = [];
    for (const r of rows) {
        const steps = {};
        const ops = await c.query(
            `select function_name, output, started_at_epoch_ms s, completed_at_epoch_ms e from dbos.operation_outputs
             where workflow_uuid = $1 and function_name in ('entry-points','agent:plan','agent:plan:early','acquire:base:1','acquire:pr:1') order by function_id`,
            [r.run_id],
        );
        for (const o of ops.rows)
            steps[o.function_name] = {
                out: parse(o.output),
                startedAt: Number(o.s) || null,
                endedAt: Number(o.e) || null,
            };
        // Each replay round's gate step (probe:<index>:<id>:<side>:<round>): the compared fields and the
        // health, never the request log, so run.js can decide the recorded rounds again with the current gate.
        const replay = (
            await c.query(
                `select function_name, output from dbos.operation_outputs where workflow_uuid = $1 and function_name like 'probe:%' order by function_id`,
                [r.run_id],
            )
        ).rows.flatMap((o) => {
            const m = /^probe:(\d+):/.exec(o.function_name);
            const g = parse(o.output)?.gate;
            const response =
                g && g.fields?.json === 'not_json' && g.stepId
                    ? recordedResponse(orgs, r.run_id, g.side, g.stepId)
                    : null;
            return m && g
                ? [
                      {
                          index: Number(m[1]),
                          probeId: g.probeId,
                          side: g.side,
                          round: g.round,
                          transport: g.transport,
                          vmHealth: g.vmHealth,
                          timedOut: g.timedOut,
                          fields: g.fields,
                          expectedHolds: g.expectedHolds,
                          ...(response ? { response } : {}),
                      },
                  ]
                : [];
        });
        const input = parse(
            (
                await c.query(
                    `select inputs from dbos.workflow_input where workflow_uuid = $1`,
                    [r.run_id],
                )
            ).rows[0]?.inputs,
        );
        const req = (Array.isArray(input) ? input[0] : input) || {};
        const early = steps['agent:plan:early'];
        const late = steps['agent:plan'];
        const plan =
            early?.out?.kind === 'planned'
                ? { source: 'early', ...early.out.plan }
                : late?.out && !late.out.claimFailure
                  ? { source: 'plan', ...late.out }
                  : null;
        const timed = plan?.source === 'early' ? early : late;
        const report = r.report || {};
        out.push({
            runId: r.run_id,
            repo: r.repository_name,
            pr: r.pr_number,
            headSha: r.head_sha,
            baseSha: r.base_sha,
            state: r.state,
            verdict: r.verdict_state,
            requestedAt: r.requested_at,
            finishedAt: r.finished_at,
            targets: req.environment?.expose ?? null,
            diff: (req.diff || []).map((d) => ({
                path: d.path,
                patch: (d.patch || '').slice(0, PATCH_CHARS),
                ...(d.content
                    ? { content: d.content.slice(0, CONTENT_CHARS + 1) }
                    : {}),
            })),
            entryPoints: steps['entry-points']?.out ?? null,
            plan: plan && {
                source: plan.source,
                probes: (plan.probes || []).map((p) => ({
                    entryPoint: p.entryPoint,
                    via: p.via ?? null,
                    assertions: p.assertions ?? null,
                    probe: {
                        id: p.probe?.id,
                        spec: p.probe?.spec,
                        expected: p.probe?.expected,
                    },
                })),
                cannotProve: plan.cannotProve || [],
                rejected: plan.rejected || [],
                usage: plan.usage || null,
                recon: plan.recon ?? null,
                reusedFrom: plan.reusedFrom ?? null,
                plannerVersion: plan.plannerVersion ?? null,
            },
            planTiming: timed && {
                startedAt: timed.startedAt,
                endedAt: timed.endedAt,
                baseReadyAt: steps['acquire:base:1']?.endedAt ?? null,
                prReadyAt: steps['acquire:pr:1']?.endedAt ?? null,
            },
            outcome: {
                check: report.check?.title ?? null,
                probes: (report.probes || []).map((p) => ({
                    probeId: p.probeId,
                    entryPoint: p.entryPoint,
                    verdict: p.verdict,
                    findingKind: p.findingKind ?? null,
                    intent: p.intent ?? null,
                    differingFields: p.differingFields ?? [],
                    baseStatus: statusOf(p.lanes?.base),
                    prStatus: statusOf(p.lanes?.pr),
                })),
                uncovered: report.uncovered || [],
                noRuntimeEffect: report.noRuntimeEffect ?? null,
            },
            replay,
        });
    }
    return out;
}

async function authors(c) {
    const repoOf = {};
    for (const x of (
        await c.query(
            `select workflow_uuid, inputs from dbos.workflow_input where workflow_uuid like 'setup:%'`,
        )
    ).rows) {
        const m = /"repositoryName":"([^"]+)"/.exec(x.inputs || '');
        if (m) repoOf[x.workflow_uuid] = m[1];
    }
    const rows = await c.query(
        `select workflow_uuid, function_id, function_name, output, started_at_epoch_ms s, completed_at_epoch_ms e from dbos.operation_outputs
         where (function_name = 'recipe:author' or function_name like 'recipe:repair:%') and started_at_epoch_ms > extract(epoch from now() - make_interval(days => $1)) * 1000
         order by started_at_epoch_ms`,
        [SINCE_DAYS],
    );
    const out = [];
    for (const x of rows.rows) {
        const repo = repoOf[x.workflow_uuid];
        if (!repo || !REPO.test(repo)) continue;
        const v = parse(x.output) || {};
        const b = (
            await c.query(
                `select output from dbos.operation_outputs where workflow_uuid = $1 and function_id > $2
                 and (function_name = 'boot' or function_name like 'boot:%' or function_name like 'learn:boot%') and function_name not like '%progress%'
                 order by function_id limit 1`,
                [x.workflow_uuid, x.function_id],
            )
        ).rows[0];
        const bo = b ? parse(b.output) : null;
        out.push({
            setup: x.workflow_uuid,
            step: x.function_name,
            repo,
            at: new Date(Number(x.s)).toISOString(),
            ms: Number(x.e) - Number(x.s),
            status: v.status ?? null,
            code: v.code ?? null,
            reason: v.reason ?? null,
            usage: v.usage ?? null,
            boot: !bo
                ? null
                : bo.claimId
                  ? 'ready'
                  : bo.status === 'blocked'
                    ? `blocked:${(bo.blockers || []).map((k) => `${k.kind}/${k.signature}`).join('+')}`
                    : 'other',
        });
    }
    return out;
}

(async () => {
    const c = new Client({
        connectionString:
            process.env.RUNTIME_DATABASE_READ_URL ||
            process.env.RUNTIME_DATABASE_URL,
    });
    await c.connect();
    await c.query('SET default_transaction_read_only = on');
    try {
        process.stdout.write(
            JSON.stringify({
                exportedAt: new Date().toISOString(),
                sinceDays: SINCE_DAYS,
                bodies: evidenceOrgs().length > 0,
                runs: await runs(c),
                authors: await authors(c),
            }),
        );
    } finally {
        await c.end();
    }
})().catch((e) => {
    console.error(`export failed: ${e.message}`);
    process.exit(2);
});
