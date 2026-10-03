#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821, precisao: roda o reducer (agrupa, funde duplicados, descarta por
 * merito) sobre um pool JA JULGADO, sem gerar candidato novo, e mede recall e
 * precisao antes e depois com as matrizes do juiz que ja existem.
 *
 *   RECALL_MODEL=<modelo do pool> node reducer-agrupamento.js \
 *     --pool=<rodada> --modo=light|heavy --fonte=pos|pre [--teto=3] [--par=4] --out=arquivo.json
 *
 * light = so o G; heavy = G + M3 (9 lentes, ate 3 passos).
 * pos   = os candidatos que o verificador manteve (preFilterCandidates);
 * pre   = os mantidos + os que o verificador derrubou.
 * O reducer roda no MESMO modelo do pool (BYOK unico) e investiga o codigo com
 * grep/readFile no worktree do PR, com teto de passos e o ultimo passo forcado
 * a submeter.
 */
const fs = require('fs');
const path = require('path');
const { tool, jsonSchema } = require('ai');
const { runReducer } = require('../dedup/reducer-runner');
const { buildModel, descreveModelo } = require('./eval-model');
const { prepareRepo } = require('./prepare-repo');
const { LocalRepoCommands } = require('./local-repo-commands');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const POOL = arg('pool');
const MODO = arg('modo', 'light');
const FONTE = arg('fonte', 'pos');
const TETO = Number(arg('teto', '3'));
const PAR = Number(arg('par', '4'));
const OUT = arg('out');
// --codigo=1: anexa a cada candidato o trecho do arquivo nas linhas dele
// (attachExistingCode, a mesma leitura que a review faz). Sem a flag, o
// existingCode que o modelo tenha escrito sai, como na rodada original.
const CODIGO = arg('codigo', '0') === '1';
// --sem-drop=1: so agrupa e funde; nada e descartado nesta etapa.
const SEM_DROP = arg('sem-drop', '0') === '1';
// --descricao-fundida=1: o representante de um grupo passa a ser julgado pela
// mergedDescription que o reducer escreveu (o texto que seria postado).
const DESCRICAO = arg('descricao-fundida', '0') === '1';
const { loadJudgeKey, matchCommentDetailed } = require('./recall-judge');
const { attachExistingCode } = require('../../libs/code-review/infrastructure/agents/engine/attach-existing-code.ts');
const MODELO = process.env.RECALL_MODEL;
if (!POOL || !OUT || !MODELO) throw new Error('uso: RECALL_MODEL=... --pool= --modo= --fonte= --out=');

const CORE = new Set(['bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect']);
const TECS = MODO === 'heavy' ? new Set(['G', 'M3']) : new Set(['G']);
const tec = (l) =>
    l === 'generalist-base' ? 'G' : l === 'synthesis-rescue' ? 'S' : l.startsWith('micro-exp-p1g-') ? 'M1' : l.startsWith('micro-exp-p3-') ? 'M3' : '?';

function readTools(cmd) {
    return {
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({
                type: 'object',
                properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } },
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
                properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } },
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

/** Candidatos do modo/fonte com a coluna de cada um nas matrizes do juiz. */
function candidatosDoPr(j) {
    const t = j.trace || {};
    const lista = [];
    (t.preFilterCandidates || []).forEach((c, i) => {
        if (TECS.has(tec(c.producedBy || ''))) lista.push({ c, src: 'M', col: i });
    });
    if (FONTE === 'pre') {
        const derrubados = (t.verification?.decisions || [])
            .filter((d) => d.action === 'drop' && d.droppedFinding)
            .map((d) => ({ ...d.droppedFinding, relevantFile: d.relevantFile }));
        derrubados.forEach((c, i) => {
            if (TECS.has(tec(c.producedBy || ''))) lista.push({ c, src: 'D', col: i });
        });
    }
    return lista;
}

/** Recall (goldens core casados) e precisao (vencedores / sobreviventes), regra Martian. */
function placar(itens, mat, matD) {
    const g0 = (mat || matD).goldens;
    let gold = 0;
    const venceu = new Set();
    g0.forEach((g, gi) => {
        if (!CORE.has(g.category)) return;
        let b = 0, q = -1;
        itens.forEach((it, k) => {
            const m = it.src === 'M' ? mat : matD;
            const x = it.confs ? it.confs[gi] || 0 : m?.conf?.[gi]?.[it.col] || 0;
            if (x > b) { b = x; q = k; }
        });
        if (q >= 0) { gold++; venceu.add(q); }
    });
    return { gold, cand: itens.length, tp: venceu.size };
}

(async () => {
    const dir = path.join(__dirname, 'pools', POOL);
    const M = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', `matriz-${POOL}.json`), 'utf8'));
    const D = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', `matriz-descartados-${POOL}.json`), 'utf8'));
    const vars = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (v?.caseId) vars[v.caseId] = v;
        } catch {}
    }
    const L30 = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8'));
    const model = buildModel(MODELO);
    const chaveJuiz = DESCRICAO ? loadJudgeKey() : null;
    // Muse, Kimi e GLM recusam tool_choice nomeado (Kimi/GLM por causa do thinking).
    const ehMuse = /muse|kimi|glm/i.test(MODELO);
    console.log(`[reducer] ${descreveModelo(MODELO)} · ${POOL} · ${MODO}/${FONTE} · teto ${TETO}`);

    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { prs: {} };
    const SO = (arg('only', '') || '').split(',').filter(Boolean);
    const fila = L30.filter((c) => (!SO.length || SO.includes(c)) && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        const j = JSON.parse(fs.readFileSync(path.join(dir, `${cid}.raw.txt`), 'utf8'));
        const itens = candidatosDoPr(j);
        const antes = placar(itens, M[cid], D[cid]);
        if (itens.length <= 1) {
            res.prs[cid] = { antes, depois: antes, kept: itens.map((_, k) => k), merged: 0, dropped: 0, noOp: false, steps: 0, ms: 0 };
            return;
        }
        const h = await prepareRepo(vars[cid], `${cid}-red-${process.pid}`);
        const t0 = Date.now();
        try {
            let r, ultimo;
            for (let t = 0; t < 4 && !r; t++) {
                try {
                    const base = itens.map((x) => ({ ...x.c, existingCode: undefined }));
                    const cands = CODIGO && h ? await attachExistingCode(base, new LocalRepoCommands(h.dir)) : base;
                    r = await runReducer(cands, {
                        model,
                        investigate: !!h,
                        readTools: h ? readTools(new LocalRepoCommands(h.dir)) : undefined,
                        maxSteps: TETO,
                        forceFinal: true,
                        namedToolChoice: !ehMuse,
                        mergeOnly: SEM_DROP,
                    });
                } catch (e) {
                    ultimo = e;
                    await new Promise((ok) => setTimeout(ok, 10000 * 2 ** t));
                }
            }
            if (!r) throw ultimo;
            let vivos = (r.kept || []).map((k) => itens[k]).filter(Boolean);
            let descricoes = 0;
            if (DESCRICAO) {
                const porIndice = new Map((r.raw?.keep || []).map((k) => [Number(k?.index), k]));
                const gs = (M[cid] || D[cid]).goldens;
                vivos = await Promise.all((r.kept || []).map(async (k) => {
                    const e = porIndice.get(k);
                    const texto = e && Array.isArray(e.mergedFrom) && e.mergedFrom.length && e.mergedDescription;
                    if (!texto) return itens[k];
                    descricoes++;
                    const confs = await Promise.all(gs.map(async (g) => {
                        if (!CORE.has(g.category)) return 0;
                        const v = await matchCommentDetailed(chaveJuiz, g.comment, texto);
                        return v?.match ? v.confidence ?? 0 : 0;
                    }));
                    return { ...itens[k], confs };
                }));
                vivos = vivos.filter(Boolean);
            }
            res.prs[cid] = {
                antes,
                depois: placar(vivos, M[cid], D[cid]),
                kept: r.kept,
                merged: [...(r.merged || new Map()).values()].flat().length,
                dropped: (r.dropped || []).length,
                noOp: !!r.noOp,
                steps: r.steps,
                usage: r.usage,
                ms: Date.now() - t0,
                semRepo: !h,
                // Decisao por candidato, para separar perda por fusao de perda por descarte.
                decisoes: { keep: r.raw?.keep, drop: r.raw?.drop },
                descricoesFundidas: descricoes,
            };
        } catch (e) {
            res.prs[cid] = { antes, erro: String(e?.message || e).slice(0, 300) };
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => {
        while (i < fila.length) await um(fila[i++]);
    }));

    const soma = (k, f) => Object.values(res.prs).filter((p) => p[k]).reduce((a, p) => a + f(p[k]), 0);
    const total = L30.reduce((a, c) => a + (M[c]?.goldens || D[c]?.goldens || []).filter((g) => CORE.has(g.category)).length, 0);
    const resumo = (k) => {
        const gold = soma(k, (x) => x.gold), cand = soma(k, (x) => x.cand), tp = soma(k, (x) => x.tp);
        // Mesma conta da pagina de recall: goldens / (goldens + candidatos que nao venceram nenhum).
        const fp = cand - tp;
        return { gold, recall: gold / total, cand, fp, precisao: gold + fp ? gold / (gold + fp) : 0 };
    };
    res.resumo = {
        modelo: MODELO, pool: POOL, modo: MODO, fonte: FONTE, teto: TETO, total,
        prs: Object.keys(res.prs).length,
        erros: Object.values(res.prs).filter((p) => p.erro).length,
        noOp: Object.values(res.prs).filter((p) => p.noOp).length,
        antes: resumo('antes'),
        depois: resumo('depois'),
        merged: Object.values(res.prs).reduce((a, p) => a + (p.merged || 0), 0),
        dropped: Object.values(res.prs).reduce((a, p) => a + (p.dropped || 0), 0),
    };
    fs.writeFileSync(OUT, JSON.stringify(res));
    console.log(JSON.stringify(res.resumo));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
