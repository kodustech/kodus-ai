#!/usr/bin/env node
/**
 * Uma rodada de discussao com o Astra nas divergencias de 2+ niveis. Para cada item
 * cuja ultima fala no historico e do Claude, manda pacote + historico inteiro e grava a resposta.
 *   node debate-astra.js --debates=<debates.json> [--pausa=30] [--espera429=60] [--par=2]
 * debates.json: { "<chave>|<caseId>|<id>": { pacote, historico: [{autor:'claude'|'astra', severity, texto}] } }
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const FILE = arg('debates'), PAUSA = Number(arg('pausa', '30')) * 1000, ESPERA_429 = Number(arg('espera429', '60')) * 1000, PAR = Number(arg('par', '2'));
const RUBRICA = fs.readFileSync(path.join(__dirname, 'rubrica.md'), 'utf8');
const SCHEMA = { type: 'object', additionalProperties: false, required: ['severity', 'reply'],
    properties: { severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, reply: { type: 'string' } } };
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-deb-'));
    try {
        fs.writeFileSync(path.join(tmp, 'schema.json'), JSON.stringify(SCHEMA));
        await run('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high',
            '--output-schema', path.join(tmp, 'schema.json'), '-o', path.join(tmp, 'out.json'), '-'], text, tmp);
        return JSON.parse(fs.readFileSync(path.join(tmp, 'out.json'), 'utf8'));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
const texto = (d) => {
    const x = d.pacote;
    const hist = d.historico.map((h) => h.autor === 'astra'
        ? `[You] severity: ${h.severity}\n${h.texto}`
        : `[Other reviewer] severity: ${h.severity}\n${h.texto}`).join('\n\n');
    return `${RUBRICA}
You rated the severity of the code review comment below, and another reviewer, who can read the whole repository, disagrees by two or more levels. Read their argument and any code they quote, then give your severity now. Keep your rating if you still think it is right and say why; change it if their argument shows you misjudged how bad the stated problem is or how often the code runs. Answer in at most five sentences.

<comment id="${x.id}">
File: ${x.file}
Lines: ${x.lines[0] ?? '?'}-${x.lines[1] ?? '?'}
${x.texto.trim()}

Code at the pull request head:
${x.recorte}
</comment>

<discussion>
${hist}
</discussion>`;
};
(async () => {
    const D = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const fila = Object.keys(D).filter((k) => D[k].historico.at(-1).autor === 'claude' && !D[k].fechado);
    let i = 0, erros = 0;
    const um = async (k) => {
        for (let t = 1; t <= 4; t++) {
            try {
                const r = await astra(texto(D[k]));
                D[k].historico.push({ autor: 'astra', severity: r.severity, texto: r.reply });
                fs.writeFileSync(FILE, JSON.stringify(D, null, 1));
                console.log('ok', k, r.severity);
                if (PAUSA) await dorme(PAUSA);
                return;
            } catch (e) {
                console.error('falha', t, k, String(e.message).slice(-200));
                if (t === 4) erros++; else await dorme(/429|Too Many|rate/i.test(String(e.message)) ? ESPERA_429 : 5000);
            }
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    console.log(JSON.stringify({ rodada: fila.length, erros }));
    process.exit(erros ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
