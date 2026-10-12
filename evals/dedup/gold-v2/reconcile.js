#!/usr/bin/env node
/**
 * Gold de duplicatas v2 (#1821): junta os dois juizes (Opus 5.5 + GPT-6 Astra).
 *
 * - Grupo aceito: os dois juizes formaram exatamente o mesmo conjunto de
 *   membros e nenhum deu confianca baixa.
 * - multiProblem aceito: os dois marcaram a sugestao como multiProblem, apontam
 *   para os mesmos grupos (comparados pelos membros) e concordam se ha problema
 *   descoberto; nenhum deu confianca baixa.
 * - Unica aceita: os dois a deixaram em unique, sem confianca baixa.
 * - O resto vira item de revisao, pelo grupo inteiro: a componente conexa das
 *   sugestoes envolvidas, com a visao de cada juiz.
 *
 * Saida: 09.10.26_<model>.labels.json (rotulo consolidado por sugestao) e
 *        09.10.26_<model>.review.json (itens para revisao manual).
 *
 *   node evals/dedup/gold-v2/reconcile.js [--models=a,b] [--prs=a,b]
 */
const fs = require('fs');
const path = require('path');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const MODELS = (arg('models') || '').split(',').filter(Boolean);
const PRS = (arg('prs') || '').split(',').filter(Boolean);
const JUDGES = ['opus', 'astra'];
const key = (ids) => [...ids].sort().join(',');

function view(ans) {
    const groupOf = {};
    const groups = {};
    for (const g of ans.groups || []) {
        groups[g.id] = g;
        for (const id of g.members) groupOf[id] = g.id;
    }
    const multi = Object.fromEntries((ans.multiProblem || []).map((m) => [m.id, m]));
    const unique = Object.fromEntries((ans.unique || []).map((u) => [u.id, u]));
    return { groups, groupOf, multi, unique };
}

const golds = fs.readdirSync(__dirname).filter((f) => /^09\.10\.26_[^.]+(\.[^.]+)*\.json$/.test(f) && !/\.(labels|review)\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')))
    .filter((g) => g.prs && (!MODELS.length || MODELS.includes(g.model)));

for (const gold of golds) {
    const labels = { model: gold.model, sourcePool: gold.sourcePool, prs: {} };
    const review = [];
    let falta = 0;
    for (const [caseId, pr] of Object.entries(gold.prs)) {
        if (PRS.length && !PRS.includes(caseId)) continue;
        const files = JUDGES.map((j) => path.join(__dirname, 'runs', j, gold.model, `${caseId}.json`));
        const tem = files.map((f) => fs.existsSync(f));
        if (!tem.some(Boolean)) { falta++; continue; }
        // Um juiz so (o outro recusou, ex.: filtro de seguranca do Opus): vale a
        // leitura de quem respondeu, por decisao do Junior; o rotulo leva a fonte.
        const fonte = tem.every(Boolean) ? 'consenso' : JUDGES[tem.indexOf(true)];
        const lido = files.map((f) => (fs.existsSync(f) ? view(JSON.parse(fs.readFileSync(f, 'utf8')).answer) : null));
        const [O, A] = fonte === 'consenso' ? lido : [lido[tem.indexOf(true)], lido[tem.indexOf(true)]];
        const ids = pr.suggestions.map((s) => s.id);
        const memSet = (v, gid) => key(v.groups[gid].members);

        // Grupos com o mesmo conjunto de membros nos dois juizes.
        const okGroups = new Map();
        for (const g of Object.values(O.groups)) {
            const k = key(g.members);
            const a = Object.values(A.groups).find((x) => key(x.members) === k);
            if (a && g.confidence !== 'low' && a.confidence !== 'low') okGroups.set(k, { o: g, a });
        }
        const accepted = new Set();
        for (const k of okGroups.keys()) for (const id of k.split(',')) accepted.add(id);
        const relatedKeys = (v, m) => key(m.relatedGroups.map((g) => memSet(v, g)));
        for (const id of ids) {
            if (accepted.has(id)) continue;
            const om = O.multi[id], am = A.multi[id];
            if (om && am && om.confidence !== 'low' && am.confidence !== 'low'
                && relatedKeys(O, om) === relatedKeys(A, am)
                && (om.uncoveredProblems.length > 0) === (am.uncoveredProblems.length > 0)) accepted.add(id);
            const ou = O.unique[id], au = A.unique[id];
            if (ou && au && ou.confidence !== 'low' && au.confidence !== 'low') accepted.add(id);
        }

        // Revisao: componentes conexas das sugestoes nao aceitas, ligando por
        // grupo (em qualquer juiz) e por multiProblem -> membros dos grupos relacionados.
        const adj = Object.fromEntries(ids.map((id) => [id, new Set()]));
        const link = (a, b) => { adj[a]?.add(b); adj[b]?.add(a); };
        for (const v of [O, A]) {
            for (const g of Object.values(v.groups)) for (const m of g.members) link(g.members[0], m);
            for (const m of Object.values(v.multi)) for (const gid of m.relatedGroups) for (const x of v.groups[gid].members) link(m.id, x);
        }
        const visto = new Set();
        for (const id of ids) {
            if (accepted.has(id) || visto.has(id)) continue;
            const comp = [];
            const pilha = [id];
            while (pilha.length) {
                const x = pilha.pop();
                if (visto.has(x)) continue;
                visto.add(x);
                comp.push(x);
                for (const y of adj[x]) pilha.push(y);
            }
            const naComp = (v) => ({
                groups: Object.values(v.groups).filter((g) => g.members.some((m) => comp.includes(m))),
                multiProblem: Object.values(v.multi).filter((m) => comp.includes(m.id)),
                unique: Object.values(v.unique).filter((u) => comp.includes(u.id)),
            });
            review.push({
                caseId, ids: comp.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
                motivo: comp.some((x) => [O, A].some((v) => {
                    const g = v.groupOf[x] && v.groups[v.groupOf[x]];
                    return (g && g.confidence === 'low') || v.multi[x]?.confidence === 'low' || v.unique[x]?.confidence === 'low';
                })) ? 'discordancia ou confianca baixa' : 'discordancia',
                opus: naComp(O), astra: naComp(A),
                suggestions: pr.suggestions.filter((s) => comp.includes(s.id)),
            });
        }

        // Rotulo consolidado (so o que foi aceito; o resto fica pendente de revisao).
        const out = {};
        for (const s of pr.suggestions) out[s.id] = { status: accepted.has(s.id) ? 'aceito' : 'revisar', fonte };
        let gi = 0;
        for (const { o } of okGroups.values()) {
            const gid = `G${++gi}`;
            for (const m of o.members) Object.assign(out[m], { group: gid, kind: o.kind, problem: o.problem, related: o.members.filter((x) => x !== m) });
            o._gid = gid;
        }
        const gidPorMembros = Object.fromEntries([...okGroups.values()].map(({ o }) => [key(o.members), o._gid]));
        for (const id of ids) {
            const om = O.multi[id];
            if (!accepted.has(id) || !om) continue;
            const rel = om.relatedGroups.map((g) => gidPorMembros[memSet(O, g)]).filter(Boolean);
            const relIds = om.relatedGroups.flatMap((g) => O.groups[g].members);
            const temDescoberto = om.uncoveredProblems.length > 0;
            Object.assign(out[id], {
                multiProblem: true, problems: om.problems, relatedGroups: rel, related: relIds,
                uncoveredProblems: om.uncoveredProblems,
                // Redundante: todos os problemas dela ja tem grupo e nenhum ficou descoberto.
                redundant: !temDescoberto && om.relatedGroups.length > 0,
            });
        }
        for (const s of pr.suggestions) Object.assign(out[s.id], { ...s, ...out[s.id] });
        labels.prs[caseId] = out;
    }
    const base = path.join(__dirname, `09.10.26_${gold.model}`);
    fs.writeFileSync(`${base}.labels.json`, JSON.stringify(labels, null, 1));
    fs.writeFileSync(`${base}.review.json`, JSON.stringify(review, null, 1));
    const sug = Object.values(labels.prs).flatMap((p) => Object.values(p));
    console.log(`${gold.model}: PRs ${Object.keys(labels.prs).length} (sem os dois juizes: ${falta}) | sugestoes ${sug.length} | aceitas ${sug.filter((x) => x.status === 'aceito').length} | itens de revisao ${review.length} (${review.reduce((n, r) => n + r.ids.length, 0)} sugestoes)`);
}
