#!/usr/bin/env node
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Builds the PR debugger: one HTML page that answers, for a finished run and
 * for each PR in it, whether every step before and after the model call did
 * what it was supposed to.
 *
 * Why it exists: three separate measurement bugs in this investigation were
 * invisible until someone read a dump by hand — an adapter silently dropping
 * four parameters, a shard worker inheriting the generalist's whole prompt, and
 * a corpus feeding six files of a 127-file PR. Each one produced numbers that
 * looked fine. The checks here are COMPUTED, not asserted: the file count is
 * compared against `git diff --name-only` on the real clone, the prompt is
 * inspected for the production diff format, and the model's own call count is
 * read from the transport.
 *
 * Usage:
 *   node evals/investigation/build-pr-debugger.js --dump=<dir> [--results=a,b] [--out=<file>]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { repoDirFor } = require('./prepare-repo');
const { tracesByName, traceUrl, filteredUrl } = require('./langfuse-traces');
try {
    require('dotenv').config({ path: '.env.local', override: true });
} catch {}

const DATASETS = path.join(__dirname, 'datasets');
const RESULTS = path.join(__dirname, 'results');
const LANGFUSE = process.env.LANGFUSE_BASE_URL || 'https://us.cloud.langfuse.com';

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const DUMP = arg('dump');
const OUT = arg('out', path.join(__dirname, 'results', 'pr-debugger.html'));
const RESULT_FILES = (arg('results', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!DUMP) {
    console.error('need --dump=<dir>');
    process.exit(1);
}

const esc = (v) =>
    String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
const short = (f) => String(f || '').split('/').slice(-1)[0];
const num = (n) => Number(n || 0).toLocaleString('pt-BR');

// ---- sources -------------------------------------------------------------

function datasetsById() {
    const out = new Map();
    for (const f of fs.readdirSync(DATASETS)) {
        if (!f.endsWith('.json')) continue;
        let vars;
        try {
            vars = JSON.parse(fs.readFileSync(path.join(DATASETS, f), 'utf8'))[0].vars;
        } catch {
            continue;
        }
        if (vars?.caseId) out.set(vars.caseId, vars);
    }
    return out;
}

function rowsById(files) {
    const out = new Map();
    const list = files.length
        ? files
        : fs.readdirSync(RESULTS).filter((f) => f.endsWith('.json'));
    for (const f of list) {
        const p = path.join(RESULTS, f.endsWith('.json') ? f : `${f}.json`);
        if (!fs.existsSync(p)) continue;
        let d;
        try {
            d = JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
            continue;
        }
        const stamp = fs.statSync(p).mtimeMs;
        for (const r of d.rows || []) {
            const prev = out.get(r.caseId);
            // Several result files can carry the same case (retries, splits);
            // the newest write is the one this dump belongs to.
            if (!prev || prev.stamp < stamp) out.set(r.caseId, { ...r, stamp, file: path.basename(p) });
        }
    }
    return out;
}

/** Ground truth: what the PR actually changed, straight from the clone. */
function gitFileCount(vars) {
    const repo = repoDirFor(vars.repositoryFullName);
    if (!repo || !fs.existsSync(repo)) return null;
    const head = vars.benchmarkHeadRef;
    if (!head) return null;
    let base = vars.benchmarkBaseRef;
    try {
        if (!base) base = execFileSync('git', ['-C', repo, 'rev-parse', `${head}^`], { encoding: 'utf8' }).trim();
        const names = execFileSync(
            'git',
            ['-C', repo, 'diff', '--name-status', '--no-renames', base, head],
            { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
        )
            .split('\n')
            .filter(Boolean);
        return {
            total: names.length,
            // Deleted files carry no post-image, so the renderer skips them —
            // they are not a gap.
            reviewable: names.filter((l) => !l.startsWith('D')).length,
        };
    } catch {
        return null;
    }
}

// ---- the checks ----------------------------------------------------------

/** Each check returns {ok, label, detail}. `ok: null` = could not be verified
 *  from this run's data (an older run without the pipeline block), which is
 *  reported as such instead of being quietly passed. */
function buildChecks(vars, trace, git) {
    const p = trace.pipeline;
    const passes = (trace.recallPasses || []).length;
    const checks = [];

    checks.push(
        p
            ? {
                  ok: p.repoPrepared,
                  label: 'Repositório preparado',
                  detail: p.repoPrepared
                      ? `worktree em ${short(p.repoDir)} · HEAD ${String(p.headSha || '').slice(0, 8)}`
                      : 'sem clone local — o agente caiu no replay gravado',
              }
            : { ok: null, label: 'Repositório preparado', detail: 'não registrado neste run' },
    );

    if (git && p) {
        const gap = git.reviewable - p.filesInPrompt;
        checks.push({
            ok: gap <= 0,
            label: 'Carregou todos os arquivos do PR',
            detail:
                gap <= 0
                    ? `${p.filesInPrompt} de ${git.reviewable} arquivos revisáveis (${git.total} no diff, ${git.total - git.reviewable} removidos)`
                    : `${p.filesInPrompt} de ${git.reviewable} — faltaram ${gap}`,
        });
    } else if (git) {
        checks.push({
            ok: null,
            label: 'Carregou todos os arquivos do PR',
            detail: `git diz ${git.reviewable} revisáveis; o run não registrou quantos usou`,
        });
    }

    checks.push(
        p
            ? {
                  ok: p.diffSource === 'changedFilesFull',
                  label: 'Usou o diff completo (não o recorte de 6 arquivos)',
                  detail:
                      p.diffSource === 'changedFilesFull'
                          ? `changedFilesFull · ${p.filesInFullDiff} arquivos (o recorte antigo tinha ${p.filesInDataset})`
                          : `changedFiles — recorte antigo, ${p.filesInDataset} arquivos`,
              }
            : { ok: null, label: 'Usou o diff completo', detail: 'não registrado neste run' },
    );

    if (p) {
        checks.push({
            ok: p.filesWithEmptyPatch === 0,
            label: 'Todo arquivo entrou com o diff preenchido',
            detail:
                p.filesWithEmptyPatch === 0
                    ? `${p.filesInPrompt} arquivos, nenhum com patch vazio`
                    : `${p.filesWithEmptyPatch} arquivo(s) sem conteúdo de diff`,
        });
        checks.push({
            ok: !p.legacyHunkFormat,
            label: 'Diff no formato de produção',
            detail: p.legacyHunkFormat
                ? 'contém __new hunk__ — formato do extrator antigo, não o de produção'
                : 'unified com números de linha (convertToUnifiedDiffWithLineNumbers)',
        });
        checks.push({
            ok: p.diffBlocksInPrompt === p.filesInPrompt,
            label: 'Todos os arquivos chegaram no prompt',
            detail: `${p.diffBlocksInPrompt} blocos "###" no prompt para ${p.filesInPrompt} arquivos`,
        });
        checks.push({
            ok: !!p.contextWindowTokens,
            label: 'Janela de contexto informada (compressor ativo)',
            detail: p.contextWindowTokens
                ? `${num(p.contextWindowTokens)} tokens · prompt ${num(Math.round((p.systemPromptChars + p.userPromptChars) / 4))} tokens estimados`
                : 'não passada — compressor desligado',
        });
        checks.push({
            ok: p.callGraphChars > 0,
            label: 'Call graph no prompt',
            detail: p.callGraphChars
                ? `${num(p.callGraphChars)} chars de <CallGraph>`
                : 'ausente',
        });
    }

    const served = trace.modelServed;
    checks.push({
        ok: !!(served && served.calls > 0),
        label: 'LLM chamado com o diff',
        detail: served
            ? `${served.modelId} · ${served.calls} chamadas no transporte`
            : 'sem registro de chamada',
    });
    checks.push({
        ok: passes > 0,
        label: 'Passadas executadas',
        detail: `${passes} passada(s): ${(trace.recallPasses || []).map((x) => x.label).join(', ') || '—'}`,
    });
    checks.push({
        ok: trace.finishReason === 'completed' || trace.finishReason === 'stopped',
        label: 'Loop terminou sem erro',
        detail: `finishReason: ${trace.finishReason || '?'} · source: ${trace.source || '?'}`,
    });

    const unserved = (trace.unexpectedToolCalls || []).length;
    checks.push({
        ok: unserved === 0,
        label: 'Todas as chamadas de ferramenta foram atendidas',
        detail: `${num(trace.replayCalls || 0)} chamadas, ${unserved} não atendidas`,
    });

    const red = trace.dedup;
    const candidates = (trace.preFilterCandidates || []).length;
    // Skipping with a single candidate is the correct behaviour, not a fault —
    // a debugger that raises those is one nobody reads.
    const legitimatelySkipped =
        !!red && red.status !== 'reducer' && candidates <= 1;
    checks.push({
        ok: (!!red && red.status === 'reducer') || legitimatelySkipped,
        label: 'Reducer executado',
        detail: !red
            ? 'sem registro'
            : red.status === 'reducer'
              ? `${red.before} → ${red.after} · ${red.merged} merges · ${red.dropped} descartes`
              : legitimatelySkipped
                ? `pulado corretamente — ${candidates} candidato(s), nada a consolidar`
                : `não rodou: ${red.reason || red.status} (com ${candidates} candidatos)`,
    });

    return checks;
}

// ---- assembly ------------------------------------------------------------

const ds = datasetsById();
const rows = rowsById(RESULT_FILES);
const cases = [];
let runStamp = 0;

for (const file of fs.readdirSync(DUMP)) {
    if (!file.endsWith('.raw.txt')) continue;
    const full = path.join(DUMP, file);
    runStamp = Math.max(runStamp, fs.statSync(full).mtimeMs);
    let dump;
    try {
        dump = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
        continue;
    }
    const id = dump.caseId || file.replace('.raw.txt', '');
    const vars = ds.get(id);
    const trace = dump.trace || {};
    const row = rows.get(id);
    const git = vars ? gitFileCount(vars) : null;

    const goldens = (() => {
        if (!vars) return [];
        const g =
            typeof vars.goldenComments === 'string'
                ? JSON.parse(vars.goldenComments)
                : vars.goldenComments || [];
        const missed = new Set();
        const m = String(row?.reason || '').match(/missed\[[^\]]*\]:\s*(.*)$/);
        if (m)
            for (const x of m[1].split(' | '))
                missed.add(String(x).replace(/«[^»]*»/g, '').slice(0, 55).trim());
        return g.map((x) => ({
            text: x.comment,
            sev: x.severity,
            found: !missed.has(String(x.comment).replace(/«[^»]*»/g, '').slice(0, 55).trim()),
        }));
    })();

    const hits = row?.metadata?.findingHit || [];
    cases.push({
        id,
        repo: vars?.repositoryFullName || '?',
        title: vars?.prTitle || id,
        url: vars?.benchmarkSourceUrl,
        checks: buildChecks(vars || {}, trace, git),
        git,
        pipeline: trace.pipeline,
        passes: trace.recallPasses || [],
        candidates: trace.preFilterCandidates || [],
        findings: (dump.findings || []).map((f, i) => ({ ...f, hit: !!hits[i] })),
        goldens,
        usage: trace.usage || {},
        metrics: row?.metadata || {},
        reducer: trace.dedup,
        runName: trace.pipeline?.langfuseRunName || null,
        langfuse: null,
        langfuseList: null,
        langfuseTraces: [],
        langfuseNote: null,
        env: trace.pipeline?.langfuseEnvironment,
    });
}

cases.sort((a, b) => a.repo.localeCompare(b.repo) || a.id.localeCompare(b.id));

const when = new Date(runStamp).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const totalChecks = cases.reduce((a, c) => a + c.checks.length, 0);
const failed = cases.reduce((a, c) => a + c.checks.filter((x) => x.ok === false).length, 0);
const unknown = cases.reduce((a, c) => a + c.checks.filter((x) => x.ok === null).length, 0);
const prsWithFail = cases.filter((c) => c.checks.some((x) => x.ok === false)).length;

module.exports = { cases, when, totalChecks, failed, unknown, prsWithFail, DUMP, OUT, esc, short, num };

/**
 * Fills each case's Langfuse links from the API. The dump's mtimes bound the
 * window: a run writes its dump as it goes, so the earliest file is close to
 * when the first trace was emitted, and one hour of slack on either side
 * absorbs a slow flush without widening the query enough to time out.
 */
async function resolveLangfuse() {
    if (!cases.some((c) => c.runName)) return;
    const HOUR = 3600 * 1000;
    const since = Math.min(...cases.map(() => runStamp)) - 6 * HOUR;
    const env = cases.find((c) => c.env)?.env || process.env.LANGFUSE_ENVIRONMENT || null;

    let byName;
    try {
        byName = await tracesByName({ since, until: runStamp + HOUR, environment: env, base: LANGFUSE });
    } catch (err) {
        for (const c of cases) c.langfuseNote = `falha ao consultar a API: ${String(err.message || err).slice(0, 120)}`;
        return;
    }
    const apiErr = byName.get('__error__');

    for (const c of cases) {
        if (!c.runName) continue;
        // `bench:<id>` and every sibling the run spawned under it (`-plan`,
        // and one root per parentless model call).
        const found = [];
        for (const [name, list] of byName) {
            if (name === '__error__') continue;
            if (name === c.runName || name.startsWith(c.runName + '-')) found.push(...list);
        }
        found.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
        if (!found.length) {
            c.langfuseNote = apiErr
                ? `API do Langfuse recusou a consulta (${String(apiErr).slice(0, 90)})`
                : `nenhum trace com o nome ${c.runName} na janela do run`;
            continue;
        }
        const pid = found[0].projectId;
        c.langfuseTraces = found.map((t) => ({
            id: t.id,
            name: t.name,
            ts: t.ts,
            url: traceUrl(LANGFUSE, pid, t.id),
        }));
        c.langfuse = c.langfuseTraces[0].url;
        c.langfuseList = filteredUrl(LANGFUSE, pid, c.runName);
    }
}

if (require.main === module) {
    resolveLangfuse()
        .catch(() => {})
        .then(() => {
            const { render } = require('./pr-debugger-template');
            fs.writeFileSync(OUT, render(module.exports));
            const withTrace = cases.filter((c) => c.langfuse).length;
            console.log(
                `${cases.length} PRs · ${totalChecks} verificações · ${failed} NÃO OK · ${unknown} não verificáveis · ${withTrace} com trace do Langfuse\n-> ${OUT}`,
            );
        });
}
