#!/usr/bin/env node
/**
 * Gold de duplicatas v2 (#1821): compara o agrupamento do dedup de producao
 * (dedup-real/<versao>/<model>.json) com o gold final (09.10.26_<model>.final.json).
 *
 * Duas leituras do dedup:
 *   - LLM: os grupos que o prompt propos, sem guarda;
 *   - producao: depois do guarda do agent-review.stage (lexico >= 0.3 honra;
 *     senao cosseno >= 0.7 honra, < 0.4 veta, no meio o desempate decide).
 *
 * Metricas:
 *   - sugestoes iguais: a sugestao cai exatamente no mesmo conjunto nos dois;
 *   - grupos do gold reproduzidos: grupo (2+) do gold que o dedup formou igual;
 *   - comentarios: quantos sobram (1 por grupo + soltas);
 *   - pares: dos pares que o gold junta, quantos o dedup juntou (cobertura) e
 *     dos pares que o dedup juntou, quantos o gold junta (acerto).
 *
 *   node evals/dedup/gold-v2/comparar-dedup.js <versao> [model ...]
 */
const fs = require('fs');
const path = require('path');
const { DEDUP_CONTENT_THRESHOLD, DEDUP_EMBEDDING_LOW, DEDUP_EMBEDDING_HIGH } = { DEDUP_CONTENT_THRESHOLD: 0.3, DEDUP_EMBEDDING_LOW: 0.4, DEDUP_EMBEDDING_HIGH: 0.7 };

const FLAGS = process.argv.slice(2).filter((a) => a.startsWith('--'));
const [VERSAO, ...ARGS] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// --sem-sanitizador: tira as sugestoes que o sanitizador descarta antes do dedup
// (evals/suggestion-sanitizer/dataset/<model>.json), dos dois lados.
const SEM_SANITIZADOR = FLAGS.includes('--sem-sanitizador');
const foraDoDedup = (model) => {
    const f = path.join(__dirname, '..', '..', 'suggestion-sanitizer', 'dataset', `${model}.json`);
    return SEM_SANITIZADOR && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).semProblema : {};
};
const DIR = path.join(__dirname, 'dedup-real', VERSAO);
const MODELS = ARGS.length ? ARGS : fs.readdirSync(DIR).map((f) => f.replace(/\.json$/, ''));
const honra = (p) => p.lex >= DEDUP_CONTENT_THRESHOLD || p.cos >= DEDUP_EMBEDDING_HIGH || (p.cos >= DEDUP_EMBEDDING_LOW && p.tb === true);

/** ids -> rotulo do conjunto a que pertence. */
function particao(ids, grupos) {
    const de = {};
    for (const g of grupos) {
        const m = g.filter((x) => ids.includes(x) && !de[x]);
        if (m.length < 2) continue;
        const k = [...m].sort().join(',');
        for (const x of m) de[x] = k;
    }
    for (const x of ids) if (!de[x]) de[x] = x;
    return de;
}

const pares = (de) => {
    const s = new Set();
    const ids = Object.keys(de);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (de[ids[i]] === de[ids[j]]) s.add([ids[i], ids[j]].sort().join('|'));
    return s;
};

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
const linhas = [];
for (const model of MODELS) {
    const fin = JSON.parse(fs.readFileSync(path.join(__dirname, `09.10.26_${model}.final.json`), 'utf8')).prs;
    const ded = JSON.parse(fs.readFileSync(path.join(DIR, `${model}.json`), 'utf8')).prs;
    const fora = foraDoDedup(model);
    for (const modo of ['LLM', 'producao']) {
        const c = { sug: 0, iguais: 0, gruposGold: 0, gruposIguais: 0, comGold: 0, comDedup: 0, pg: 0, pd: 0, pa: 0 };
        for (const [cid, pr] of Object.entries(fin)) {
            const d = ded[cid];
            if (!d || d.erro) continue;
            const ids = Object.keys(pr).filter((id) => !(fora[cid] || []).includes(id));
            const gGold = {};
            for (const [id, s] of Object.entries(pr)) if (s.grupo) (gGold[s.grupo] = gGold[s.grupo] || []).push(id);
            const G = particao(ids, Object.values(gGold));
            // keep invalido: a producao mantem as duplicatas como independentes.
            const gruposD = (d.groups || []).filter((g) => g.keep).map((g) => {
                if (modo === 'LLM') return [g.keep, ...g.duplicates];
                const ok = g.duplicates.filter((x) => {
                    const p = (d.pares || []).find((q) => q.dup === x && q.keep === g.keep);
                    return !p || honra(p);
                });
                return [g.keep, ...ok];
            });
            const D = particao(ids, gruposD);
            c.sug += ids.length;
            for (const x of ids) if (G[x] === D[x]) c.iguais++;
            const gk = new Set(Object.values(gGold).map((m) => [...m].sort().join(',')));
            const dk = new Set(Object.values(D));
            c.gruposGold += gk.size;
            for (const k of gk) if (dk.has(k)) c.gruposIguais++;
            c.comGold += new Set(Object.values(G)).size;
            c.comDedup += dk.size;
            const pG = pares(G), pD = pares(D);
            c.pg += pG.size; c.pd += pD.size;
            for (const p of pD) if (pG.has(p)) c.pa++;
        }
        linhas.push({ model, dedup: modo, sugestoes: c.sug, 'sugestoes iguais': pct(c.iguais, c.sug), 'grupos do gold reproduzidos': `${c.gruposIguais}/${c.gruposGold} (${pct(c.gruposIguais, c.gruposGold)})`, 'comentarios gold': c.comGold, 'comentarios dedup': c.comDedup, 'pares do gold juntados': pct(c.pa, c.pg), 'pares juntados que o gold junta': pct(c.pa, c.pd) });
    }
}
console.table(linhas);
