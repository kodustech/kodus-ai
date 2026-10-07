#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: conferencia "isso e realmente um bug?" so nas sugestoes achadas por um
 * unico agente, antes do dedup. Quem e de agente unico sai dos grupos de um dedup
 * ja rodado (--grupos): grupo com um so producedBy distinto. Agent loop por
 * sugestao, teto 3 (grep/readFile), diff do PR, existingCode da etapa do LLM,
 * no modelo do cenario. real=false -> a sugestao sai antes do dedup.
 *
 *   RECALL_MODEL=<id> node conferencia-agente-unico.js --codigo=<ec-llm> --grupos=<dedup com codigo> --pool=<orig> --out=arq.json
 *   saida: {prs: {caseId: {conferidas: {indice: {real, reason, passos}}}}}
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { prepareRepo } = require('./prepare-repo');
const { LocalRepoCommands } = require('./local-repo-commands');
const { extraiJson } = require('./eval-structured');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const CODIGO = JSON.parse(fs.readFileSync(arg('codigo'), 'utf8')).prs;
const GRUPOS = JSON.parse(fs.readFileSync(arg('grupos'), 'utf8')).prs;
const POOL = arg('pool'), OUT = arg('out'), PAR = Number(arg('par', '3'));
const MODELO = process.env.RECALL_MODEL;
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const TETO = 3;

const SUBMIT = { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string', description: 'One sentence citing file:line.' } }, required: ['real', 'reason'] };
const SYSTEM = `You check ONE code review finding on a pull request: is it really a bug in this code?

real = true when the code does what the finding says and that produces a wrong result: a crash, wrong value, lost or corrupted data, security exposure, or a broken feature.
real = false when the finding is wrong about the code, the described failure cannot happen (a guard, validation, type or earlier return prevents it), or it is not a defect at all.

Read the code before deciding. If you cannot tell within your steps, answer real = true.`;

const prompt = (c, diff) => `<PullRequestDiff>
${diff}
</PullRequestDiff>

File: ${c.relevantFile}
Lines: ${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? c.relevantLinesStart ?? '?'}
Finding: ${c.suggestionContent}
Code:
${c.existingCode}

You have up to ${TETO} steps. The LAST one is your answer — submitting is itself a step — so you have up to ${TETO - 1} to read code with.
Submit with submitVerdict: {"real": true|false, "reason": "..."}.`;

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

async function sessao(model, cmd, c, diff) {
    let enviado = null;
    const tools = { ...ferramentas(cmd), submitVerdict: tool({ description: 'Submit your verdict. The only way to answer.', inputSchema: jsonSchema(SUBMIT), execute: async (x) => { enviado = x; return 'recorded'; } }) };
    const r = await generateText({
        model, system: SYSTEM, prompt: prompt(c, diff), tools,
        stopWhen: (x) => !!enviado || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['submitVerdict'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submitVerdict' } }),
                messages: [...messages, { role: 'user', content: 'Final step: submit your verdict now. If you could not tell, answer real = true.' }] }
            : undefined,
    });
    if (!enviado) enviado = extraiJson(r.text || '');
    if (!enviado || typeof enviado.real !== 'boolean') throw new Error('sem veredito');
    return { real: enviado.real, reason: String(enviado.reason || '').slice(0, 300), passos: r.steps?.length ?? 0 };
}

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = buildModel(MODELO);
    console.log(`[conferencia] ${descreveModelo(MODELO)} · teto ${TETO}`);
    const vars = {}, diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            let arr = v?.changedFilesFull; if (typeof arr === 'string') arr = JSON.parse(arr);
            if (v?.caseId) { vars[v.caseId] = v; diffs[v.caseId] = (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n'); }
        } catch {}
    }
    const L30 = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8'));
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { modelo: MODELO, prs: {} };
    const fila = L30.filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
            const cod = CODIGO[cid].codigo;
            // Agente unico: todos os membros de grupos com um so producedBy distinto.
            const alvos = [];
            for (const mem of Object.values(GRUPOS[cid].membros)) {
                if (new Set(mem.map((x) => cs[x].producedBy)).size === 1) alvos.push(...mem);
            }
            const conferidas = {};
            if (alvos.length) {
                h = await prepareRepo(vars[cid], `${cid}-cf-${process.pid}`);
                if (!h) throw new Error('sem repo');
                const cmd = new LocalRepoCommands(h.dir);
                let j = 0;
                await Promise.all(Array.from({ length: 4 }, async () => {
                    while (j < alvos.length) {
                        const k = alvos[j++];
                        conferidas[k] = await retry(() => sessao(model, cmd, { ...cs[k], existingCode: cod[k] }, diffs[cid]));
                    }
                }));
            }
            res.prs[cid] = { conferidas };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const ds = ok.flatMap((p) => Object.values(p.conferidas));
    console.log(JSON.stringify({ prs: ok.length, erros: Object.keys(res.prs).length - ok.length, conferidas: ds.length, falsas: ds.filter((d) => !d.real).length }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
