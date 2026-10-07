#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: verify por arquivo, sobre a fila do corte de 65%. Uma sessao por arquivo,
 * com TODOS os comentarios da fila naquele arquivo (os do topo 3 aparecem como
 * contexto e nao podem cair), ferramentas e teto alto. Para cada comentario fora
 * do topo: keep, drop (sem falha concreta) ou duplicate (repete outro comentario
 * do mesmo arquivo). Saida no formato do verify-etapa3.js.
 *
 *   RECALL_MODEL=<id> node verify-arquivo.js --fila=<arq> --fusao=<arq> --pool=<orig> --out=arq.json
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { prepareRepo } = require('./prepare-repo');
const { LocalRepoCommands } = require('./local-repo-commands');
const { extraiJson } = require('./eval-structured');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const Q = JSON.parse(fs.readFileSync(arg('fila'), 'utf8'));
const F = JSON.parse(fs.readFileSync(arg('fusao'), 'utf8')).prs;
const POOL = arg('pool'), OUT = arg('out'), PAR = Number(arg('par', '3'));
const SO = (arg('only', '') || '').split(',').filter(Boolean);
const MODELO = process.env.RECALL_MODEL;
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const TOPO = 3, TETO = 12;
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase();

const SUBMIT = {
    type: 'object',
    properties: {
        itens: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    indice: { type: 'number' },
                    verdict: { type: 'string', enum: ['keep', 'drop', 'duplicate'] },
                    duplicateOf: { type: 'number', description: 'Only for duplicate: the index of the comment it repeats.' },
                    reason: { type: 'string', description: 'One sentence citing file:line.' },
                },
                required: ['indice', 'verdict', 'reason'],
            },
        },
    },
    required: ['itens'],
};

const SYSTEM = `You check the code review comments that will be posted on ONE file of a pull request. You see all of them together. Read the code with the tools before deciding.

For each comment marked TO CHECK, decide:
- keep: you can state, from the code you read, a concrete input, state or sequence of calls that reaches the code and produces a wrong result (crash, wrong value, lost or corrupted data, security exposure, broken feature). Concurrent, adversarial and edge cases count if the code allows them; a caller in another file counts.
- drop: after reading the code there is no such path: a guard, validation or type prevents it, the path is unreachable, the comment is wrong about the code, or what it describes is true but produces no wrong result for anyone.
- duplicate: it reports the same defect (same root cause in the same code) as another comment of this file; give that comment's index. Only one comment per defect should be posted.

Comments marked POSTED are already decided: use them as context and as duplicate targets, never drop them. Decide from the code, not from the wording. If you cannot tell within your steps, keep.`;

const prompt = (arquivo, itens, diff) => `<PullRequestDiff>
${diff}
</PullRequestDiff>

File: ${arquivo}

<Comments>
${itens.map((x, i) => `[${i}] ${x.alvo ? 'TO CHECK' : 'POSTED'} · lines ${x.ini ?? '?'}-${x.fim ?? '?'}\n${String(x.texto || '').slice(0, 1500)}`).join('\n\n')}
</Comments>

You have up to ${TETO} steps; the last one is your answer. Submit with submitVerdicts, one entry per TO CHECK index.`;

function ferramentas(cmd) {
    return {
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
            execute: async ({ pattern, path: p, glob }) => { try { return String(await cmd.grep(pattern, p, glob)).slice(0, 6000); } catch (e) { return `grep failed: ${String(e.message || e).slice(0, 120)}`; } },
        }),
        readFile: tool({
            description: 'Read a file, optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => { try { const t = String(await cmd.read(p, startLine, endLine)); const b = Number(startLine) > 0 ? Number(startLine) : 1; return t.split('\n').map((l, k) => `${b + k}: ${l}`).join('\n').slice(0, 12000); } catch (e) { return `readFile failed: ${String(e.message || e).slice(0, 120)}`; } },
        }),
    };
}

async function sessao(model, cmd, arquivo, itens, diff) {
    let enviado = null;
    const tools = { ...ferramentas(cmd), submitVerdicts: tool({ description: 'Submit the verdicts. The only way to answer.', inputSchema: jsonSchema(SUBMIT), execute: async (x) => { enviado = x; return 'recorded'; } }) };
    const r = await generateText({
        model, system: SYSTEM, prompt: prompt(arquivo, itens, diff), tools,
        stopWhen: (x) => !!enviado || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['submitVerdicts'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submitVerdicts' } }),
                messages: [...messages, { role: 'user', content: 'Final step: submit your verdicts now. If you could not tell for a comment, keep it.' }] }
            : undefined,
    });
    if (!enviado) enviado = extraiJson(r.text || '');
    return { dados: enviado, passos: r.steps?.length ?? 0 };
}

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = buildModel(MODELO);
    console.log(`[verify-arquivo] ${descreveModelo(MODELO)} · topo ${TOPO} · teto ${TETO}`);
    const vars = {}, diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            let arr = v?.changedFilesFull; if (typeof arr === 'string') arr = JSON.parse(arr);
            if (v?.caseId) { vars[v.caseId] = v; diffs[v.caseId] = (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n'); }
        } catch {}
    }
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { modelo: MODELO, variante: 'arquivo', prs: {} };
    const fila = Object.keys(Q).filter((c) => (!SO.length || SO.includes(c)) && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const reps = Q[cid] || [];
            const decis = {};
            for (const r of reps.slice(0, TOPO)) decis[r] = { v1: { keep: true, leuCitado: true, garantido: true, passos: 0 } };
            if (reps.length > TOPO) {
                const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
                const textoDe = Object.fromEntries(F[cid].itens.map((it) => [it.rep, it.texto || cs[it.rep].suggestionContent]));
                const porArquivo = {};
                reps.forEach((r, p) => { (porArquivo[norm(cs[r].relevantFile)] = porArquivo[norm(cs[r].relevantFile)] || []).push({ r, alvo: p >= TOPO, ini: cs[r].relevantLinesStart, fim: cs[r].relevantLinesEnd, texto: textoDe[r], file: cs[r].relevantFile }); });
                h = await prepareRepo(vars[cid], `${cid}-va-${process.pid}`);
                if (!h) throw new Error('sem repo');
                const cmd = new LocalRepoCommands(h.dir);
                const grupos = Object.values(porArquivo).filter((g) => g.some((x) => x.alvo));
                let j = 0;
                await Promise.all(Array.from({ length: 3 }, async () => {
                    while (j < grupos.length) {
                        const g = grupos[j++];
                        const out = await retry(() => sessao(model, cmd, g[0].file, g, diffs[cid]));
                        const por = Object.fromEntries(((out.dados?.itens) || []).map((x) => [Number(x.indice), x]));
                        g.forEach((x, k) => {
                            if (!x.alvo) return;
                            const v = por[k];
                            const verdict = v && ['keep', 'drop', 'duplicate'].includes(v.verdict) ? v.verdict : 'keep';
                            // duplicata so vale apontando para outro comentario do arquivo que fica.
                            const alvoDup = verdict === 'duplicate' ? g[Number(v.duplicateOf)] : null;
                            const keep = verdict === 'keep' || (verdict === 'duplicate' && (!alvoDup || alvoDup.r === x.r));
                            decis[x.r] = { v1: { keep, leuCitado: true, verdict, duplicateOf: alvoDup ? alvoDup.r : null, texto: String(v?.reason || '').slice(0, 300), passos: out.passos, semVeredito: !v } };
                        });
                    }
                }));
            }
            res.prs[cid] = { decisoes: decis };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const ds = ok.flatMap((p) => Object.values(p.decisoes)).filter((d) => !d.v1.garantido);
    const vd = {}; for (const d of ds) vd[d.v1.verdict] = (vd[d.v1.verdict] || 0) + 1;
    console.log(JSON.stringify({ prs: ok.length, erros: Object.keys(res.prs).length - ok.length, verificadas: ds.length, veredito: vd, derrubadas: ds.filter((d) => !d.v1.keep).length, semVeredito: ds.filter((d) => d.v1.semVeredito).length }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
