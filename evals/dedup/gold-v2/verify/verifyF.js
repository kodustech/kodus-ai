#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Verify F (#1821): redescoberta as cegas, depois do verify C, so nos grupos de
 * um membro. Duas sessoes revisam a regiao citada sem ver o comentario; uma
 * chamada decide se algum defeito achado e o mesmo do comentario. Derruba o que
 * nao foi redescoberto.
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/verify/verifyF.js --model=<gold model> [--versao=f1] [--prs=arquivo]
 */
const fs = require('fs');
const path = require('path');
const { grupos, carregaFinal } = require('../grupos-producao');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { generateText, tool, jsonSchema } = require('ai');
const INV = path.join(__dirname, '..', '..', '..', 'investigation');
const { buildModel, descreveModelo } = require(path.join(INV, 'eval-model'));
const { extraiJson, chamadaEstruturada } = require(path.join(INV, 'eval-structured'));
const { prepareRepo } = require(path.join(INV, 'prepare-repo'));
const { LocalRepoCommands } = require(path.join(INV, 'local-repo-commands'));
const execFileAsync = promisify(execFile);

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const GOLD = arg('model'), VERSAO = arg('versao', 'f1'), PAR = Number(arg('par', '3')), DEDUP = arg('dedup', 'v9-cobertura');
const MODELO = process.env.RECALL_MODEL;
if (!GOLD || !MODELO) { console.error('RECALL_MODEL=<id> --model=<gold model>'); process.exit(2); }
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const OUT = path.join(__dirname, 'resultados', `verify-F-${VERSAO}`, `${GOLD}.json`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const SOBRE = JSON.parse(fs.readFileSync(path.join(__dirname, 'resultados', arg('sobre', 'aluc-h1t10f'), `${GOLD}.json`), 'utf8')).prs;
const SO_PRS = arg('prs') ? new Set(fs.readFileSync(arg('prs'), 'utf8').split(/\s+/).filter(Boolean)) : null;
const TETO_CEGO = Number(arg('tetoCego', '8')), TETO_ATAQUE = Number(arg('tetoAtaque', '5'));

const comentario = (s) => `<Comment>
File: ${s.relevantFile}
Lines: ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}
Label: ${s.label ?? '?'}
${String(s.suggestionContent || '').trim()}
</Comment>`;

const S_ACHADOS = {
    type: 'object',
    properties: {
        defects: { type: 'array', maxItems: 6, items: { type: 'object', properties: { lines: { type: 'string' }, description: { type: 'string', description: 'The concrete defect: what goes wrong, when, and why.' } }, required: ['lines', 'description'], additionalProperties: false } },
    },
    required: ['defects'],
    additionalProperties: false,
};
const pRevisa = (s, diff, k) => `You are reviewing a pull request. ${k === 0 ? 'Focus on the region below.' : 'Look closely at the region below; check how its code interacts with the rest of the repository.'}

Region: ${s.relevantFile} lines ${Math.max(1, Number(s.relevantLinesStart || 1) - 10)}-${Number(s.relevantLinesEnd || s.relevantLinesStart || 1) + 10}

<Diff>
${diff}
</Diff>

Read the region and the code it depends on with grep, readFile and listDir at the pull request's head commit. List the concrete defects in this region that the pull request introduces or exposes: bugs, security problems, broken contracts, wrong documentation or tests that do not check what they claim. Report only defects you can explain from the code. List none if there are none. You have at most ${TETO_CEGO} steps in total. Answer with submit.`;

const S_CASA = {
    type: 'object',
    properties: { match: { type: 'boolean' }, which: { type: 'string' } },
    required: ['match', 'which'],
    additionalProperties: false,
};
const pCasa = (s, lista) => `A review comment and a list of defects found independently in the same code region. Does any listed defect describe the same problem as the comment: the same cause and the same consequence? A defect in the same lines with a different cause or consequence does not count.

${comentario(s)}

<Defects>
${lista.map((d, k) => `${k + 1}. [${d.lines}] ${d.description}`).join('\n') || '(none)'}
</Defects>

Answer only in the requested JSON: match true or false, and which item matches.`;

function ferramentas(cmd, baseCtx) {
    const t = {
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
            execute: async ({ pattern, path: p, glob }) => String(await cmd.grep(pattern, p, glob)).slice(0, 6000),
        }),
        readFile: tool({
            description: 'Read a file at the pull request head, optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => { const x = String(await cmd.read(p, startLine, endLine)); const b = Number(startLine) > 0 ? Number(startLine) : 1; return x.split('\n').map((l, k) => `${b + k}: ${l}`).join('\n').slice(0, 12000); },
        }),
        listDir: tool({
            description: 'List a directory of the repository.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, maxDepth: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, maxDepth }) => String(await cmd.listDir(p, maxDepth)).slice(0, 6000),
        }),
    };
    if (baseCtx) t.readBaseFile = tool({
        description: 'Read a file as it was BEFORE the pull request (base commit), optionally a line range.',
        inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
        execute: async ({ path: p, startLine, endLine }) => {
            try {
                const { stdout } = await execFileAsync('git', ['-C', baseCtx.dir, 'show', `${baseCtx.base}:${String(p).replace(/^\/+/, '')}`], { maxBuffer: 32 * 1024 * 1024 });
                const ls = stdout.split('\n'); const a = Math.max(1, Number(startLine) || 1), b = Math.min(ls.length, Number(endLine) || ls.length);
                return ls.slice(a - 1, b).map((l, k) => `${a + k}: ${l}`).join('\n').slice(0, 12000);
            } catch { return 'file not found at the base commit (new in this pull request, or wrong path)'; }
        },
    });
    return t;
}

// Claude por assinatura: sessao do Agent SDK com Read/Grep/Glob no worktree; o
// base dos arquivos alterados fica materializado em .pr-base/.
const TIER0 = require(path.join(INV, '..', 'shared', 'tier0-models')).TIER0;
const PELO_SDK = TIER0[MODELO]?.provider === 'claude_agent_sdk';
async function loopSdk(model, prompt, schema, dir, teto) {
    const { carregaSdk, envDoProcesso } = require(path.join(INV, 'claude-sdk-runner'));
    const sdk = await carregaSdk();
    const texto = prompt
        .replace(/, and readBaseFile to read a file as it was before the pull request/g, '; the version of each changed file from before the pull request is under .pr-base/ (same relative path)')
        .replace('Answer with submit.', `End your answer with ONLY a JSON object matching this schema, no code fence:\n${JSON.stringify(schema)}`);
    let saida = '';
    try {
        for await (const msg of sdk.query({ prompt: texto, options: {
            model: TIER0[MODELO].sdkModel,
            systemPrompt: 'You can read the repository at the pull request head with the grep, readFile and listDir tools.',
            ...require(require('path').join(__dirname, '../../../shared/claude-sdk-repo')).servidorRepo(sdk, dir),
            disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
            settingSources: [], cwd: dir, maxTurns: teto + 4, env: envDoProcesso() } })) {
            if (msg.type === 'assistant') for (const b of msg.message.content || []) if (b.type === 'text') saida += b.text + '\n';
            if (msg.type === 'result' && msg.result) saida += '\n' + msg.result;
        }
    } catch (e) { if (!saida) throw e; }
    const d = jsonCom(saida, schema);
    if (d) return d;
    return umTiro(model, 'answer', schema, `${prompt}\n\nThe investigation is over. These are its notes:\n<Notes>\n${saida.slice(-12000)}\n</Notes>\nAnswer from them.`);
}

async function loop(model, prompt, schema, cmd, baseCtx, teto) {
    if (PELO_SDK) return loopSdk(model, prompt, schema, cmd.repoRoot, teto);
    let resp = null;
    const tools = { ...ferramentas(cmd, baseCtx), submit: tool({ description: 'Submit your answer. Call exactly once.', inputSchema: jsonSchema(schema), execute: async (x) => { resp = x; return 'recorded'; } }) };
    const r = await generateText({
        model, prompt, tools, abortSignal: AbortSignal.timeout(400000),
        stopWhen: (x) => !!resp || (x.steps?.length ?? 0) >= teto,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= teto - 1
            ? { activeTools: ['submit'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submit' } }),
                messages: [...messages, { role: 'user', content: 'This is your final step. Call submit now, from what you already know.' }] }
            : undefined,
    });
    const d = resp || jsonCom(r.text || '', schema);
    if (d && schema.required.every((k) => k in d)) return d;
    const notas = [r.text || '', ...(r.steps || []).flatMap((st) => (st.toolResults || []).map((x) => String(x.output ?? x.result ?? '').slice(0, 1500)))].join('\n---\n').slice(-12000);
    return umTiro(model, 'answer', schema, `${prompt}\n\nThe investigation is over. These are its notes and tool outputs:\n<Notes>\n${notas}\n</Notes>\nAnswer from them.`);
}
// JSON com as chaves exigidas: o extraiJson pode devolver um objeto aninhado.
function jsonCom(texto, schema) {
    const t = String(texto || ''); let melhor = null;
    for (let i = t.indexOf('{'); i >= 0; i = t.indexOf('{', i + 1)) {
        let n = 0, str = false, esc = false;
        for (let j = i; j < t.length; j++) {
            const c = t[j];
            if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
            if (c === '"') str = true; else if (c === '{') n++; else if (c === '}' && --n === 0) {
                try { const o = JSON.parse(t.slice(i, j + 1)); if (schema.required.every((k) => k in o)) melhor = o; } catch {}
                break;
            }
        }
        if (melhor) return melhor;
    }
    return null;
}
const umTiro = async (model, nome, schema, prompt) => (PELO_SDK ? jsonCom((await generateText({ model, prompt: `${prompt}\n\nReturn ONLY a JSON object matching this schema. No prose, no code fence.\n${JSON.stringify(schema)}`, abortSignal: AbortSignal.timeout(300000) })).text, schema) : (await chamadaEstruturada({ model, modelId: MODELO, nome, schema, prompt, extra: { abortSignal: AbortSignal.timeout(300000) } })).dados);

async function verifica(model, cmd, baseCtx, s, diff) {
    const amostras = await Promise.all([0, 1].map((k) => loop(model, pRevisa(s, diff, k), S_ACHADOS, cmd, null, TETO_CEGO).catch(() => ({ defects: [] }))));
    const lista = amostras.flatMap((a) => a?.defects || []);
    const c = await umTiro(model, 'match', S_CASA, pCasa(s, lista));
    return { nit: c?.match === false, etapa: 'redescoberta', achados: lista, casa: c };
}


(async () => {
    const model = buildModel(MODELO);
    console.log(`[verify-F] ${VERSAO} · ${descreveModelo(MODELO)} · ${GOLD}`);
    const sug = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `09.10.26_${GOLD}.json`), 'utf8')).prs;
    const fin = carregaFinal('09.10.26', GOLD);
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dedup-real', DEDUP, `${GOLD}.json`), 'utf8')).prs;
    const vars = {};
    for (const f of fs.readdirSync(path.join(INV, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try { const v = JSON.parse(fs.readFileSync(path.join(INV, 'datasets', f), 'utf8'))[0].vars; if (v?.caseId) vars[v.caseId] = v; } catch {}
    }
    const diffDe = (v) => { let a = v?.changedFilesFull; if (typeof a === 'string') a = JSON.parse(a); return (a || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n').slice(0, 40000); };
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { model: GOLD, verificador: MODELO, versao: VERSAO, sobre: arg('sobre', 'aluc-h1t10f'), prs: {} };
    const fila = Object.keys(sug).filter((c) => (!SO_PRS || SO_PRS.has(c)) && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const jaCaiu = new Set((SOBRE[cid]?.grupos || []).filter((g) => g.nit).map((g) => g.rep));
            const gs = grupos(sug[cid].suggestions, fin[cid], real[cid].idsEntradaDedup || []).filter((g) => !jaCaiu.has(g.rep) && g.membros.length === 1);
            const out = [];
            if (gs.length) {
                h = await prepareRepo(vars[cid], `${cid}-vd-${process.pid}`);
                if (!h) throw new Error('sem repo');
                const cmd = new LocalRepoCommands(h.dir);
                const baseCtx = vars[cid].benchmarkBaseRef ? { dir: h.dir, base: vars[cid].benchmarkBaseRef } : null;
                const diff = diffDe(vars[cid]);
                if (PELO_SDK && baseCtx) {
                    let a = vars[cid].changedFilesFull; if (typeof a === 'string') a = JSON.parse(a);
                    for (const f of a || []) {
                        try {
                            const { stdout } = await execFileAsync('git', ['-C', h.dir, 'show', `${baseCtx.base}:${f.filename}`], { maxBuffer: 32 * 1024 * 1024 });
                            const alvo = path.join(h.dir, '.pr-base', f.filename); fs.mkdirSync(path.dirname(alvo), { recursive: true }); fs.writeFileSync(alvo, stdout);
                        } catch {}
                    }
                }
                let j = 0;
                await Promise.all(Array.from({ length: 3 }, async () => {
                    while (j < gs.length) {
                        const k = j++;
                        const v = await retry(() => verifica(model, cmd, baseCtx, gs[k].s, diff));
                        out[k] = { rep: gs[k].rep, membros: gs[k].membros, ...v };
                    }
                }));
            }
            res.prs[cid] = { grupos: out };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${gs.length} comentarios, ${out.filter((x) => x.nit).length} derrubados`);
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} FALHOU: ${res.prs[cid].erro}`);
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const todos = ok.flatMap((p) => p.grupos);
    console.log(JSON.stringify({ versao: VERSAO, model: GOLD, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, comentarios: todos.length, derrubados: todos.filter((x) => x.nit).length }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }
