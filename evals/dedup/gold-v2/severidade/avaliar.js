#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Avalia uma versao do prompt de severidade contra o rotulo (severidade/<modelo>.json),
 * nas sugestoes que sobrevivem ao nit protegido, com o modelo do proprio cenario.
 *   RECALL_MODEL=<id> node avaliar.js --versao=s1 --gold=<modelo do gold> --conjunto=<conjunto.json> [--par=6]
 */
const fs = require('fs'), path = require('path');
const INV = path.join(__dirname, '..', '..', '..', 'investigation');
const { buildModel, descreveModelo } = require(path.join(INV, 'eval-model'));
const { chamadaEstruturada } = require(path.join(INV, 'eval-structured'));
const PROMPTS = require('./prompts');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const VERSOES = arg('versao', '').split(','), AMOSTRAS = Number(arg('amostras', '1')), GOLD = arg('gold'), PAR = Number(arg('par', '6')), MODELO = process.env.RECALL_MODEL;
const ROTULO = arg('rotulo', VERSOES.join('+') + (AMOSTRAS > 1 ? `x${AMOSTRAS}` : ''));
if (!VERSOES.every((v) => PROMPTS[v]) || !GOLD || !MODELO) { console.error('RECALL_MODEL=<id> --versao=a[,b,c] [--amostras=n] --gold= --conjunto='); process.exit(2); }
const N = { low: 0, medium: 1, high: 2, critical: 3 };
const SEV = { type: 'string', enum: ['low', 'medium', 'high', 'critical'] };
const esquema = (V) => {
    const props = (campos) => Object.fromEntries(campos.map((c) => [c, c === 'severity' ? SEV : V.enums?.[c] ? { type: 'string', enum: V.enums[c] } : { type: 'string' }]));
    return V.modo === 'um'
        ? { type: 'object', additionalProperties: false, required: V.campos, properties: props(V.campos) }
        : { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['id', ...V.campos], properties: { id: { type: 'string' }, ...props(V.campos) } } } } };
};
// Voto majoritario; empate -> o nivel mais baixo entre os mais votados que estiver mais perto da mediana.
function vota(ps) {
    const c = {}; for (const p of ps) if (p) c[p] = (c[p] || 0) + 1;
    const top = Math.max(...Object.values(c)); const cand = Object.keys(c).filter((s) => c[s] === top).sort((a, b) => N[a] - N[b]);
    return cand.length === 1 ? cand[0] : cand[Math.floor((cand.length - 1) / 2)];
}
(async () => {
    const model = buildModel(MODELO);
    const itens = JSON.parse(fs.readFileSync(arg('conjunto'), 'utf8')).filter((x) => x.model === GOLD);
    const membros = VERSOES.flatMap((v) => Array.from({ length: AMOSTRAS }, () => v));
    console.log(`[severidade] ${ROTULO} · ${descreveModelo(MODELO)} · ${GOLD} · ${itens.length} sugestoes`);
    let ultimoErro = null;
    let tin = 0, tout = 0; const t0 = Date.now(); const lat = []; let chamadas = 0;
    const porMembro = await Promise.all(membros.map(async (vn) => {
        const V = PROMPTS[vn], SCHEMA = esquema(V);
        const tarefas = V.modo === 'um' ? itens.map((x) => [x])
            : Object.values(itens.reduce((a, x) => ((a[`${x.conjunto}|${x.caseId}`] ||= []).push(x), a), {}));
        chamadas += tarefas.length;
        const res = {}; let i = 0;
        await Promise.all(Array.from({ length: PAR }, async () => {
            while (i < tarefas.length) {
                const xs = tarefas[i++];
                for (let k = 1; k <= 3; k++) {
                    try {
                        const t1 = Date.now();
                        const r = await chamadaEstruturada({ model, modelId: MODELO, nome: 'submit', schema: SCHEMA, prompt: V.prompt(xs) });
                        let out = V.modo === 'um' ? [{ id: xs[0].id, ...r.dados }] : (r.dados.items || []);
                        if (V.deriva) out = out.map((o) => ({ ...o, severity: V.deriva(o) }));
                        const by = Object.fromEntries(out.map((o) => [o.id, o]));
                        if (xs.some((x) => !N.hasOwnProperty(by[x.id]?.severity))) throw new Error('resposta incompleta');
                        lat.push(Date.now() - t1);
                        tin += r.usage?.inputTokens || 0; tout += r.usage?.outputTokens || 0;
                        for (const x of xs) res[`${x.conjunto}|${x.caseId}|${x.id}`] = by[x.id].severity;
                        break;
                    } catch (e) {
                        if (k === 3) { if (!ultimoErro) console.error('erro:', String(e?.message || e).slice(0, 500)); ultimoErro = String(e?.message || e); for (const x of xs) res[`${x.conjunto}|${x.caseId}|${x.id}`] = null; }
                    }
                }
            }
        }));
        return res;
    }));
    const res = {};
    for (const x of itens) {
        const k = `${x.conjunto}|${x.caseId}|${x.id}`;
        const ps = porMembro.map((m) => m[k]);
        res[k] = { gold: x.gold, pred: ps.some(Boolean) ? vota(ps) : null, membros: ps };
    }
    const vs = Object.values(res), ok = vs.filter((r) => r.pred);
    const exato = ok.filter((r) => r.pred === r.gold).length, um = ok.filter((r) => Math.abs(N[r.pred] - N[r.gold]) <= 1).length;
    const conf = {}; for (const r of ok) conf[`${r.gold}>${r.pred}`] = (conf[`${r.gold}>${r.pred}`] || 0) + 1;
    const porConj = {}; for (const [k, r] of Object.entries(res)) { const c = k.split('|')[0]; porConj[c] ||= [0, 0]; porConj[c][1]++; if (r.pred === r.gold) porConj[c][0]++; }
    lat.sort((a, b) => a - b);
    const resumo = { versao: ROTULO, modelo: MODELO, gold: GOLD, n: vs.length, erros: vs.length - ok.length,
        exato: +(100 * exato / vs.length).toFixed(1), ateUm: +(100 * um / vs.length).toFixed(1),
        porConjunto: Object.fromEntries(Object.entries(porConj).map(([c, [a, n]]) => [c, +(100 * a / n).toFixed(1)])),
        chamadas, tokensEntrada: tin, tokensSaida: tout, tokensPorSugestao: Math.round((tin + tout) / vs.length),
        latenciaMedianaMs: lat[Math.floor(lat.length / 2)] || 0, paredeS: Math.round((Date.now() - t0) / 1000),
        acima: ok.filter((r) => N[r.pred] > N[r.gold]).length, abaixo: ok.filter((r) => N[r.pred] < N[r.gold]).length, confusao: conf };
    const OUT = path.join(__dirname, 'resultados', ROTULO, `${GOLD}.json`);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ resumo, itens: res }, null, 1));
    console.log(JSON.stringify(resumo));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
