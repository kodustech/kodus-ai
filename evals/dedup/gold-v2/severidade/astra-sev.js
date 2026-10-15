#!/usr/bin/env node
/**
 * Severidade pelo Astra: uma chamada por PR x modelo com todas as sugestoes do finder,
 * cada uma com o recorte do head (+-10 linhas). Cego a TP/FP e a nota do Claude.
 *   node astra-sev.js --pacotes=<pacotes.json> --out=<dir> [--pausa=30] [--espera429=60] [--tentativas=4] [--par=1]
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const OUT = arg('out'), PAUSA = Number(arg('pausa', '30')) * 1000, ESPERA_429 = Number(arg('espera429', '60')) * 1000;
const TENTATIVAS = Number(arg('tentativas', '4')), PAR = Number(arg('par', '1')), SO = arg('so');
const RUBRICA = fs.readFileSync(path.join(__dirname, 'rubrica.md'), 'utf8');
const SCHEMA = { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id', 'severity', 'reason'],
    properties: { id: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, reason: { type: 'string' } } } } } };
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
function run(cmd, args, input, cwd) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { cwd, env: process.env });
        let err = '';
        p.stderr.on('data', (d) => (err += d)); p.stdout.on('data', () => {});
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}: ${err.slice(-800)}`))));
        p.stdin.end(input);
    });
}
async function astra(text) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-sev-'));
    try {
        fs.writeFileSync(path.join(tmp, 'schema.json'), JSON.stringify(SCHEMA));
        await run('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high',
            '--output-schema', path.join(tmp, 'schema.json'), '-o', path.join(tmp, 'out.json'), '-'], text, tmp);
        return JSON.parse(fs.readFileSync(path.join(tmp, 'out.json'), 'utf8'));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
const bloco = (x) => `<comment id="${x.id}">\nFile: ${x.file}\nLines: ${x.lines[0] ?? '?'}-${x.lines[1] ?? '?'}\n${x.texto.trim()}\n\nCode at the pull request head:\n${x.recorte}\n</comment>`;
(async () => {
    const pac = JSON.parse(fs.readFileSync(arg('pacotes'), 'utf8'));
    const fila = [];
    for (const [k, itens] of Object.entries(pac)) {
        if (SO && !SO.split(',').includes(k)) continue;
        const porPr = {};
        for (const x of itens) (porPr[x.caseId] ||= []).push(x);
        for (const [cid, xs] of Object.entries(porPr)) fila.push({ k, cid, xs });
    }
    fs.mkdirSync(OUT, { recursive: true });
    let i = 0, feitos = 0, erros = 0;
    const um = async (q) => {
        const file = path.join(OUT, `${q.k.replace('|', '__')}__${q.cid}.json`);
        if (fs.existsSync(file)) return;
        const text = `${RUBRICA}\nThe comments below were written by an automated reviewer on one pull request. Rate every comment; return one item per comment id.\n\n${q.xs.map(bloco).join('\n\n')}`;
        for (let t = 1; t <= TENTATIVAS; t++) {
            try {
                const r = await astra(text);
                const ids = new Set(q.xs.map((x) => x.id)), got = new Set(r.items.map((x) => x.id));
                if ([...ids].some((id) => !got.has(id))) throw new Error(`faltaram ids: ${[...ids].filter((id) => !got.has(id)).join(',')}`);
                fs.writeFileSync(file, JSON.stringify({ chave: q.k, caseId: q.cid, items: r.items.filter((x) => ids.has(x.id)) }, null, 1));
                feitos++; console.log(new Date().toISOString().slice(11, 19), 'ok', q.k, q.cid, q.xs.length);
                if (PAUSA) await dorme(PAUSA);
                return;
            } catch (e) {
                const limite = /429|Too Many Requests|rate/i.test(String(e.message));
                console.error(new Date().toISOString().slice(11, 19), 'falha', t, q.k, q.cid, String(e.message).slice(-200));
                if (t === TENTATIVAS) erros++;
                else await dorme(limite ? ESPERA_429 : 5000);
            }
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    console.log(JSON.stringify({ chamadas: fila.length, feitos, erros }));
    process.exit(erros ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
