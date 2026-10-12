#!/usr/bin/env node
/**
 * Gold de duplicatas v2 (#1821): a regra de agrupamento do Junior (10/10/26).
 *
 * Cada sugestao vira um conjunto de problemas. Sugestoes que dividem algum
 * problema ficam na mesma componente. A componente vira UM grupo quando alguma
 * sugestao dela cobre todos os problemas da componente:
 *   A + AB (B so existe na AB)  -> um grupo (as A e a AB)
 *   A + B + AB                  -> um grupo (a AB e a mais completa)
 * Sem sugestao que cubra tudo (A, B, C, AB, AC, nenhuma ABC) -> pendente
 * ("complexo"), para o Junior decidir.
 *
 * De onde vem a leitura de cada sugestao:
 *   - aceita pelos dois juizes -> o consenso;
 *   - item de revisao decidido pelo Junior -> o juiz que ele escolheu, ou o
 *     agrupamento que ele escreveu ("Nenhum dos dois", "Grupo: S1, S2.");
 *   - item de revisao sem decisao -> a regra roda na leitura do Opus e na do
 *     Astra; se as duas dao o mesmo agrupamento final, fica decidido (pelo
 *     Claude); senao, pendente ("discordancia").
 *
 * Saida: 09.10.26_<model>.final.json e decisoes-claude.json (para o db da pagina).
 *
 *   node evals/dedup/gold-v2/aplicar-regra.js
 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const JUDGES = ['opus', 'astra'];
const key = (xs) => [...xs].sort().join(',');
const num = (id) => Number(String(id).slice(1));

const decisoes = {};
const ddir = path.join(DIR, 'decisoes-db', 'decisoes');
if (fs.existsSync(ddir)) for (const f of fs.readdirSync(ddir)) {
    const d = JSON.parse(fs.readFileSync(path.join(ddir, f), 'utf8'));
    decisoes[f.replace(/\.json$/, '')] = d.data || d;
}
const itemKey = (model, caseId, ids) => `${model}__${caseId}__${ids.join('-')}`.replace(/[^A-Za-z0-9_-]/g, '_');

/** Conjunto de problemas de cada sugestao, numa leitura de juiz. */
function tokens(ans, ids) {
    const T = {};
    const gtok = {};
    for (const g of ans.groups || []) {
        gtok[g.id] = `G:${key(g.members)}`;
        for (const m of g.members) T[m] = new Set([gtok[g.id]]);
    }
    for (const m of ans.multiProblem || []) {
        T[m.id] = new Set([...(m.relatedGroups || []).map((g) => gtok[g]), ...(m.uncoveredProblems || []).map((_, i) => `U:${m.id}:${i}`)]);
        if (!T[m.id].size) T[m.id].add(`U:${m.id}`);
    }
    for (const id of ids) if (!T[id]) T[id] = new Set([`U:${id}`]);
    return T;
}

/** Aplica a regra de cobertura. Devolve {grupos: [[ids]], complexos: [[ids]]}. */
function regra(T, ids) {
    const porTok = {};
    for (const id of ids) for (const t of T[id]) (porTok[t] = porTok[t] || []).push(id);
    const visto = new Set();
    const grupos = [];
    const complexos = [];
    for (const id of ids) {
        if (visto.has(id)) continue;
        const comp = [];
        const pilha = [id];
        while (pilha.length) {
            const x = pilha.pop();
            if (visto.has(x)) continue;
            visto.add(x);
            comp.push(x);
            for (const t of T[x]) for (const y of porTok[t]) pilha.push(y);
        }
        comp.sort((a, b) => num(a) - num(b));
        if (comp.length === 1) continue;
        const uniao = new Set(comp.flatMap((x) => [...T[x]]));
        const cobre = comp.some((x) => [...uniao].every((t) => T[x].has(t)));
        (cobre ? grupos : complexos).push(comp);
    }
    return { grupos, complexos };
}
const assinatura = (r) => JSON.stringify({ g: r.grupos.map(key).sort(), c: r.complexos.map(key).sort() });

const golds = fs.readdirSync(DIR).filter((f) => /^09\.10\.26_.*\.json$/.test(f) && !/\.(labels|review|final)\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const decClaude = [];
const resumo = [];

for (const gold of golds) {
    const labels = JSON.parse(fs.readFileSync(path.join(DIR, `09.10.26_${gold.model}.labels.json`), 'utf8')).prs;
    const review = JSON.parse(fs.readFileSync(path.join(DIR, `09.10.26_${gold.model}.review.json`), 'utf8'));
    const final = { model: gold.model, sourcePool: gold.sourcePool, regra: 'cobertura (10/10/26)', prs: {} };
    const cont = { sugestoes: 0, grupos: 0, emGrupo: 0, pendenteDiscordancia: 0, pendenteComplexo: 0, decididoClaude: 0, decididoJunior: 0 };
    for (const [caseId, pr] of Object.entries(gold.prs)) {
        const ids = pr.suggestions.map((s) => s.id);
        const lido = JUDGES.map((j) => {
            const f = path.join(DIR, 'runs', j, gold.model, `${caseId}.json`);
            return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).answer : null;
        });
        const base = lido[0] || lido[1];
        const itens = review.filter((r) => r.caseId === caseId);
        // Complexos que o Junior decidiu na pagina (nao vieram da reconciliacao).
        for (const d of Object.values(decisoes)) {
            if (d.model === gold.model && d.caseId === caseId && !itens.some((it) => it.ids.join('-') === d.ids.join('-'))) itens.push({ caseId, ids: d.ids });
        }
        // Leitura por sugestao: consenso por padrao; nos itens, o juiz escolhido.
        const montar = (escolhaPorItem) => {
            const T0 = tokens(base, ids);
            const T = { ...T0 };
            for (const it of itens) {
                const j = escolhaPorItem[it.ids.join('-')];
                if (Array.isArray(j)) {
                    for (const id of it.ids) T[id] = new Set([`U:${id}`]);
                    for (const g of j) for (const id of g) T[id] = new Set([`M:${key(g)}`]);
                    continue;
                }
                const v = tokens(lido[JUDGES.indexOf(j)] || base, ids);
                for (const id of it.ids) T[id] = v[id];
            }
            return T;
        };
        const status = {};
        const escolha = {};
        const abertos = [];
        for (const it of itens) {
            const d = decisoes[itemKey(gold.model, caseId, it.ids)];
            const manual = d && d.escolha === 'outra' && d.por !== 'claude'
                ? [...String(d.nota || '').matchAll(/Grupo:\s*((?:S\d+[,\s]*)+)/g)].map((m) => m[1].match(/S\d+/g)) : null;
            if (d && d.por !== 'claude' && (d.escolha === 'opus' || d.escolha === 'astra' || manual?.length)) {
                escolha[it.ids.join('-')] = manual?.length ? manual : d.escolha;
                for (const id of it.ids) status[id] = 'junior';
            } else abertos.push(it);
        }
        // Itens abertos: a regra com cada leitura; mesmo resultado -> decidido.
        for (const it of abertos) {
            const rs = JUDGES.map((j) => regra(montar({ ...escolha, [it.ids.join('-')]: j }), ids));
            const toca = (r) => [...r.grupos, ...r.complexos].filter((g) => g.some((x) => it.ids.includes(x)));
            const a = assinatura({ grupos: toca(rs[0]).filter((g) => rs[0].grupos.includes(g)), complexos: toca(rs[0]).filter((g) => rs[0].complexos.includes(g)) });
            const b = assinatura({ grupos: toca(rs[1]).filter((g) => rs[1].grupos.includes(g)), complexos: toca(rs[1]).filter((g) => rs[1].complexos.includes(g)) });
            // Um juiz so (o outro recusou): as duas leituras seriam a mesma, entao nao decide.
            if (lido.every(Boolean) && a === b && !toca(rs[0]).some((g) => rs[0].complexos.includes(g))) {
                escolha[it.ids.join('-')] = 'opus';
                for (const id of it.ids) status[id] = 'claude';
                const grupos = toca(rs[0]).filter((g) => rs[0].grupos.includes(g));
                const soltas = it.ids.filter((x) => !grupos.some((g) => g.includes(x)));
                decClaude.push({
                    doc_id: itemKey(gold.model, caseId, it.ids),
                    data: {
                        escolha: 'outra', por: 'claude', em: new Date().toISOString(), model: gold.model, caseId, ids: it.ids,
                        nota: `Decidido pelo Claude com a regra de cobertura (as duas leituras dao o mesmo resultado). ${grupos.map((g) => `Grupo: ${g.join(', ')}.`).join(' ')}${soltas.length ? ` Unicas: ${soltas.join(', ')}.` : ''}`,
                    },
                });
            } else {
                const complexo = rs.some((r) => toca(r).some((g) => r.complexos.includes(g)));
                for (const id of it.ids) status[id] = complexo && a === b ? 'pendente-complexo' : 'pendente-discordancia';
            }
        }
        const r = regra(montar(escolha), ids);
        const out = {};
        let gi = 0;
        for (const g of r.grupos) {
            const gid = `F${++gi}`;
            for (const id of g) out[id] = { grupo: gid, membros: g };
        }
        for (const g of r.complexos) for (const id of g) out[id] = { grupo: null, complexo: g, status: status[id] || 'pendente-complexo' };
        for (const s of pr.suggestions) {
            const st = out[s.id]?.status || status[s.id] || (labels[caseId]?.[s.id]?.fonte === 'consenso' ? 'consenso' : labels[caseId]?.[s.id]?.fonte || 'consenso');
            out[s.id] = { ...s, grupo: null, ...out[s.id], status: st };
            cont.sugestoes++;
            if (out[s.id].grupo) cont.emGrupo++;
            if (st === 'pendente-discordancia') cont.pendenteDiscordancia++;
            if (st === 'pendente-complexo') cont.pendenteComplexo++;
            if (st === 'claude') cont.decididoClaude++;
            if (st === 'junior') cont.decididoJunior++;
        }
        cont.grupos += r.grupos.length;
        final.prs[caseId] = out;
    }
    fs.writeFileSync(path.join(DIR, `09.10.26_${gold.model}.final.json`), JSON.stringify(final, null, 1));
    resumo.push({ model: gold.model, ...cont });
}
fs.writeFileSync(path.join(DIR, 'decisoes-claude.json'), JSON.stringify(decClaude, null, 1));
console.table(resumo);
console.log(`decisoes do Claude para gravar na pagina: ${decClaude.length}`);
