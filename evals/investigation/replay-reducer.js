#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { registerTracing, tele, flush } = require('./eval-tracing');
/**
 * Replays the reducer offline over the COMBINED candidate set of several runs,
 * the way production would see it: one reduction at the end over everything.
 *
 * Why this is not the same as the union of two finished runs. Each run reduced
 * its own candidates separately, so a "union recall" of 55.8% is really two
 * reducers each keeping their own best. In production the passes all feed one
 * reducer, and that reducer discards 45% of what it sees and has already been
 * measured deleting four goldens the agents found correctly. The union is a
 * ceiling; this measures what actually survives.
 *
 * Costs no agent run: every candidate is already on disk in the dumps.
 *
 * Usage:
 *   node evals/investigation/replay-reducer.js --dumps=a,b --out=file.json
 */
const fs = require('fs');
const path = require('path');
const { runReducer } = require('../dedup/reducer-runner');
const { buildModel, descreveModelo } = require('./eval-model');
const { loadJudgeKey, matchCommentDetailed } = require('./recall-judge');
const { tool, jsonSchema } = require('ai');
const { prepareRepo } = require('./prepare-repo');
const { LocalRepoCommands } = require('./local-repo-commands');

/** grep/readFile over the prepared worktree, so the reducer can verify a claim
 *  instead of rating it. Same commands the agents used, same repo state. */
function readTools(cmd) {
    return {
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({
                type: 'object',
                properties: {
                    pattern: { type: 'string' },
                    path: { type: 'string' },
                    glob: { type: 'string' },
                },
                required: ['pattern'],
                additionalProperties: false,
            }),
            execute: async ({ pattern, path: p, glob }) => {
                try { return String(await cmd.grep(pattern, p, glob)).slice(0, 6000); }
                catch (e) { return `grep failed: ${String(e.message || e).slice(0, 120)}`; }
            },
        }),
        readFile: tool({
            description: 'Read a file, optionally a line range.',
            inputSchema: jsonSchema({
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    startLine: { type: 'number' },
                    endLine: { type: 'number' },
                },
                required: ['path'],
                additionalProperties: false,
            }),
            execute: async ({ path: p, startLine, endLine }) => {
                try { return String(await cmd.read(p, startLine, endLine)).slice(0, 12000); }
                catch (e) { return `readFile failed: ${String(e.message || e).slice(0, 120)}`; }
            },
        }),
    };
}

// Onde ficam os dumps. Ja foi um caminho absoluto de scratchpad cravado aqui,
// o que fazia o script falhar em silencio fora daquela sessao.
const S = process.env.POOL_ROOT || require('path').join(__dirname, 'pools');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const DUMPS = arg('dumps', 'm14,m14r,m14r8,quota1,simP').split(',');
const INVESTIGATE = process.argv.includes('--investigate');
const MAXSTEPS = Number(arg('maxsteps', '30'));
/** Só estes casos. Existe porque relançar 29 PRs para recuperar 9 que caíram
 *  por sobrecarga do provedor gasta duas vezes mais cota do que o resultado
 *  vale. */
const SO = (arg('only', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const OUT = arg('out', path.join(__dirname, 'results', 'reducer-replay.json'));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol';
registerTracing('reducer-replay');
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);

(async () => {
    // Candidates per PR, pooled across every dump that saw it.
    const pool = {};
    for (const d of DUMPS) {
        const dir = path.join(S, d);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.raw.txt'))) {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const c = j.trace?.preFilterCandidates || [];
            if (!c.length) continue;
            (pool[j.caseId] ||= []).push(...c.map((x) => ({ ...x, _from: d })));
        }
    }
    const vars = {};
    const goldens = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (v?.caseId) { goldens[v.caseId] = J(v.goldenComments); vars[v.caseId] = v; }
        } catch {}
    }

    const model = buildModel(MODEL);
    console.log(`[modelo] ${descreveModelo(MODEL)}`);
    const key = loadJudgeKey();
    const ids = Object.keys(pool)
        .filter((c) => goldens[c]?.length)
        .filter((c) => !SO.length || SO.includes(c));
    console.log(`${ids.length} PRs · ${Object.values(pool).reduce((a, b) => a + b.length, 0)} candidatos somados\n`);

    const out = [];
    const perdidos = [];
    let TP = 0, FP = 0, GOLD = 0;
    for (const [i, cid] of ids.entries()) {
        const cands = pool[cid];
        let rt;
        if (INVESTIGATE) {
            try {
                const h = await prepareRepo(vars[cid], cid);
                if (h) rt = readTools(new LocalRepoCommands(h.dir));
            } catch (e) {
                console.log(`   (sem repo para ${cid.slice(0, 30)}: ${String(e.message).slice(0, 50)})`);
            }
        }
        let kept, mergedInto, droppedIdx;
        // "Our servers are currently overloaded" took out 9 of 29 PRs on the
        // first tools run, and a missing PR is not a miss — it silently shrinks
        // the corpus and makes the recall column meaningless. Retry with a
        // widening wait rather than let the row disappear.
        const comRetry = async () => {
            let ultimo;
            for (let t = 0; t < 5; t++) {
                try {
                    return await runReducer(cands, {
                        model,
                        telemetry: tele('reducer-replay', { caseId: cid }),
                        ...(INVESTIGATE && rt ? { investigate: true, readTools: rt, maxSteps: MAXSTEPS } : {}),
                    });
                } catch (err) {
                    ultimo = err;
                    const espera = 15000 * 2 ** t;
                    console.log(`   tentativa ${t + 1} falhou (${String(err.message).slice(0, 50)}), esperando ${espera / 1000}s`);
                    await new Promise((r) => setTimeout(r, espera));
                }
            }
            throw ultimo;
        };
        try {
            const r = await comRetry();
            kept = (r.kept || []).map((k) => cands[k]).filter(Boolean);
            // MERGE and DROP are different losses and need different fixes: a
            // merged candidate still ships, folded into its representative —
            // unless the reducer stacked two unrelated defects, in which case
            // its content is gone while the index says "kept".
            mergedInto = new Map();
            for (const [rep, from] of r.merged || new Map()) {
                for (const i of from) mergedInto.set(i, rep);
            }
            droppedIdx = new Set((r.dropped || []).map((d) => (typeof d === 'number' ? d : d?.index)));
        } catch (err) {
            console.log(`[${i + 1}/${ids.length}] ${cid.slice(0, 40)} REDUTOR FALHOU: ${String(err.message).slice(0, 60)}`);
            continue;
        }
        // Where each golden ended up: matched by something kept, folded into a
        // representative by MERGE, or deleted by DROP.
        const hit = new Set();
        const txtOf = (x) => [x.oneSentenceSummary, x.suggestionContent].filter(Boolean).join('\n').slice(0, 1800);
        const casa = async (g, x) => {
            try {
                const v = await matchCommentDetailed(key, g.comment, txtOf(x));
                return !!v?.match && (v.confidence ?? 0) >= 0.5;
            } catch { return false; }
        };
        for (const g of goldens[cid]) {
            let achou = false;
            for (const s of kept) if (await casa(g, s)) { hit.add(g.comment); achou = true; break; }
            if (achou) continue;
            // Not represented by anything kept — so find the candidate that DID
            // describe it and say which operation removed it.
            for (const [i, c] of cands.entries()) {
                if (!(mergedInto.has(i) || droppedIdx.has(i))) continue;
                if (!(await casa(g, c))) continue;
                const via = mergedInto.has(i) ? 'MERGE' : 'DROP';
                const rep = mergedInto.has(i) ? cands[mergedInto.get(i)] : null;
                perdidos.push({
                    caseId: cid, via, severity: g.severity,
                    golden: g.comment,
                    candidato: c.oneSentenceSummary,
                    absorvidoPor: rep ? rep.oneSentenceSummary : null,
                });
                break;
            }
        }
        TP += hit.size; FP += Math.max(kept.length - hit.size, 0); GOLD += goldens[cid].length;
        // O conjunto mantido, nao so o tamanho dele: sem isto nao da para
        // encadear outro filtro depois do reducer sem rodar o reducer de novo,
        // que foi exatamente o que travou o teste de "reducer entao walk".
        out.push({
            caseId: cid,
            candidatos: cands.length,
            mantidos: kept.length,
            tp: hit.size,
            goldens: goldens[cid].length,
            conjunto: kept.map((c) => ({
                relevantFile: c.relevantFile,
                relevantLinesStart: c.relevantLinesStart,
                relevantLinesEnd: c.relevantLinesEnd,
                oneSentenceSummary: c.oneSentenceSummary,
                suggestionContent: c.suggestionContent,
                existingCode: c.existingCode,
                reason: c.reason,
                producedBy: c.producedBy,
            })),
        });
        console.log(`[${i + 1}/${ids.length}] ${cid.slice(0, 44).padEnd(46)} ${cands.length}→${kept.length} · tp ${hit.size}/${goldens[cid].length}`);
    }
    const rec = TP / GOLD, pre = TP / Math.max(TP + FP, 1);
    fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, dumps: DUMPS, TP, FP, GOLD, recall: rec, precision: pre, porPR: out, perdidos }, null, 2));
    console.log(`\nREDUTOR UNICO sobre o conjunto combinado`);
    console.log(`  tp=${TP} fp=${FP} de ${GOLD} goldens`);
    console.log(`  recall=${rec.toFixed(3)}  precision=${pre.toFixed(3)}`);
    const porVia = perdidos.reduce((a, p) => ((a[p.via] = (a[p.via] || 0) + 1), a), {});
    console.log(`\nGOLDENS que um candidato descrevia e nao sobreviveram: ${perdidos.length}`);
    console.log(`  por operacao: ${JSON.stringify(porVia)}`);
    for (const p of perdidos) {
        console.log(`\n  [${p.via}] [${p.severity}] ${p.caseId.slice(0, 40)}`);
        console.log(`     golden    : ${String(p.golden).replace(/\s+/g, ' ').slice(0, 104)}`);
        console.log(`     candidato : ${String(p.candidato).replace(/\s+/g, ' ').slice(0, 104)}`);
        if (p.absorvidoPor) console.log(`     absorvido : ${String(p.absorvidoPor).replace(/\s+/g, ' ').slice(0, 104)}`);
    }
    await flush();
    console.log(`\n-> ${OUT}`);
})();
