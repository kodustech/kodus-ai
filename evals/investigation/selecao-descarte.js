#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: descarte por cota depois do verify. Por PR, sobre a fila do corte de 65%:
 * N comentarios, D derrubados pelo verify (veredito em todos, sem topo protegido).
 * Falta = floor(PCT% de N - D). Se falta <= 0, o PR passa direto. Senao, os N - D
 * que sobraram vao para uma sessao (diff + grep/readFile, teto 5) que tem de
 * descartar exatamente `falta` deles, no papel de um dev senior escolhendo o que o
 * time vai corrigir.
 *
 *   --variante=reason     cada comentario recebe keep/discard + reason
 *   --variante=semreason  so a lista de indices descartados
 *   --regra=prot1|bruto   como ler o verify (prot1: derrubar so vale se leu o arquivo citado)
 *
 *   RECALL_MODEL=<id> node selecao-descarte.js --fila=<arq> --fusao=<arq> --pool=<orig> --verify=<arq> --regra=prot1 --variante=reason --pct=70 --out=arq.json
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
const V = JSON.parse(fs.readFileSync(arg('verify'), 'utf8')).prs;
const POOL = arg('pool'), OUT = arg('out'), VAR = arg('variante'), REGRA = arg('regra', 'prot1'), PCT = Number(arg('pct', '70')), PAR = Number(arg('par', '3'));
const SO = (arg('only', '') || '').split(',').filter(Boolean);
const MODELO = process.env.RECALL_MODEL;
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const TETO = 5;
if (!['reason', 'semreason'].includes(VAR)) throw new Error('--variante=reason|semreason');
const PELO_SDK = require('../shared/tier0-models').TIER0[MODELO]?.provider === 'claude_agent_sdk';

const caiNoVerify = (cid, r) => {
    const d = V[cid]?.decisoes?.[String(r)]?.v1;
    return !!d && d.keep === false && (REGRA === 'bruto' || d.leuCitado);
};

const SYSTEM = `You are a senior developer on this team. An automated review produced the comments below for a pull request. Every comment you let through will be posted, and your team will have to fix it before merging, so you decide which ones are worth your team's time.

Read the code with the tools when you need to. Then discard exactly the number of comments you are asked to discard, and keep the rest.`;

const SUBMIT = {
    reason: {
        type: 'object',
        properties: {
            decisions: {
                type: 'array',
                items: { type: 'object', properties: { index: { type: 'number' }, decision: { type: 'string', enum: ['keep', 'discard'] }, reason: { type: 'string' } }, required: ['index', 'decision', 'reason'] },
                description: 'One entry for EVERY comment.',
            },
        },
        required: ['decisions'],
    },
    semreason: {
        type: 'object',
        properties: { discard: { type: 'array', items: { type: 'number' }, description: 'The indices of the comments you discard.' } },
        required: ['discard'],
    },
};

function prompt(itens, k, diff) {
    const pedido = VAR === 'reason'
        ? `Submit with submitSelection: {"decisions": [{"index": n, "decision": "keep"|"discard", "reason": "..."}]}, one entry for every comment, with exactly ${k} "discard". The reason says why the comment is or is not worth your team fixing before merge.`
        : `Submit with submitSelection: {"discard": [indices]}, with exactly ${k} indices.`;
    return `<PullRequestDiff>
${diff}
</PullRequestDiff>

<Comments>
${itens.map((x, i) => `[${i}] ${x.file}:${x.ini ?? '?'}-${x.fim ?? x.ini ?? '?'}\n${x.texto}`).join('\n\n')}
</Comments>

There are ${itens.length} comments. Discard exactly ${k} of them and keep the other ${itens.length - k} to be posted for your team to fix.

You have up to ${TETO} steps. The LAST one is your answer — submitting is itself a step — so you have up to ${TETO - 1} to read code with.
${pedido}`;
}

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

function descartados(sel, n) {
    if (!sel) return null;
    const idx = VAR === 'reason'
        ? (Array.isArray(sel.decisions) ? sel.decisions.filter((d) => d && d.decision === 'discard').map((d) => Number(d.index)) : null)
        : (Array.isArray(sel.discard) ? sel.discard.map(Number) : null);
    return idx ? [...new Set(idx)].filter((i) => Number.isInteger(i) && i >= 0 && i < n) : null;
}

async function sessaoAiSdk(model, cmd, itens, k, diff) {
    let enviado = null;
    const tools = { ...ferramentas(cmd), submitSelection: tool({ description: 'Submit your selection. The only way to answer.', inputSchema: jsonSchema(SUBMIT[VAR]), execute: async (x) => { enviado = x; return 'recorded'; } }) };
    const r = await generateText({
        model, system: SYSTEM, prompt: prompt(itens, k, diff), tools,
        stopWhen: (x) => !!enviado || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['submitSelection'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submitSelection' } }),
                messages: [...messages, { role: 'user', content: `Final step: submit your selection now, discarding exactly ${k}.` }] }
            : undefined,
    });
    if (!enviado) enviado = extraiJson(r.text || '');
    return { sel: enviado, passos: r.steps?.length ?? 0 };
}

// Claude por assinatura: a fachada do Agent SDK nao faz chamada de ferramenta;
// a sessao roda no proprio Agent SDK com Read/Grep/Glob e a resposta em JSON no fim.
async function sessaoSdk(dir, itens, k, diff) {
    const { carregaSdk, envDoProcesso } = require('./claude-sdk-runner');
    const sdk = await carregaSdk();
    const texto = prompt(itens, k, diff)
        .replace(/Submit with submitSelection: /, 'End your answer with ONLY this JSON object, no code fence: ');
    let saida = '', turnos = 0;
    try {
        for await (const msg of sdk.query({
            prompt: texto,
            options: {
                model: require('../shared/tier0-models').TIER0[MODELO].sdkModel,
                systemPrompt: SYSTEM + '\n\nYou can read the repository with the Read, Grep and Glob tools; your working directory is the repository at the pull request head.',
                tools: ['Read', 'Grep', 'Glob'], allowedTools: ['Read', 'Grep', 'Glob'],
                disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
                settingSources: [], cwd: dir, maxTurns: TETO, env: envDoProcesso(),
            },
        })) {
            if (msg.type === 'assistant') { turnos++; for (const b of msg.message.content || []) if (b.type === 'text') saida += b.text + '\n'; }
            if (msg.type === 'result' && msg.result) saida += '\n' + msg.result;
        }
    } catch (e) {
        if (!saida) throw e;
    }
    return { sel: extraiJson(saida), passos: turnos };
}

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = PELO_SDK ? null : buildModel(MODELO);
    console.log(`[selecao] ${descreveModelo(MODELO)} · ${VAR} · descarte alvo ${PCT}% · verify ${REGRA} · teto ${TETO}`);
    const vars = {}, diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            let arr = v?.changedFilesFull; if (typeof arr === 'string') arr = JSON.parse(arr);
            if (v?.caseId) { vars[v.caseId] = v; diffs[v.caseId] = (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n'); }
        } catch {}
    }
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { modelo: MODELO, variante: VAR, pct: PCT, regra: REGRA, prs: {} };
    const fila = Object.keys(Q).filter((c) => (!SO.length || SO.includes(c)) && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const reps = Q[cid] || [];
            const n = reps.length;
            const verify = reps.filter((r) => caiNoVerify(cid, r));
            const sobram = reps.filter((r) => !verify.includes(r));
            const falta = Math.floor((PCT / 100) * n - verify.length + 1e-9);
            const out = { n, verify, sobram, falta: Math.max(0, falta), descarte: [] };
            if (falta > 0 && sobram.length > 0) {
                const k = Math.min(falta, sobram.length);
                const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
                const textoDe = Object.fromEntries(F[cid].itens.map((it) => [it.rep, it.texto]));
                const itens = sobram.map((r) => ({ r, file: cs[r].relevantFile, ini: cs[r].relevantLinesStart, fim: cs[r].relevantLinesEnd, texto: textoDe[r] || cs[r].suggestionContent }));
                h = await prepareRepo(vars[cid], `${cid}-sd-${process.pid}`);
                if (!h) throw new Error('sem repo');
                const cmd = new LocalRepoCommands(h.dir);
                // Ate 3 tentativas para acertar a contagem; depois fica o que veio.
                let tent = 0, sel = null, idx = null, passos = 0;
                while (tent < 3) {
                    tent++;
                    const s = await retry(() => (PELO_SDK ? sessaoSdk(h.dir, itens, k, diffs[cid]) : sessaoAiSdk(model, cmd, itens, k, diffs[cid])));
                    sel = s.sel; passos = s.passos; idx = descartados(sel, itens.length);
                    if (idx && idx.length === k) break;
                }
                if (!idx) throw new Error('sem selecao');
                out.k = k; out.tentativas = tent; out.passos = passos; out.contagemCerta = idx.length === k;
                out.descarte = idx.slice(0, k).map((j) => itens[j].r);
                if (VAR === 'reason') out.reasons = Object.fromEntries((sel.decisions || []).filter((d) => itens[Number(d.index)]).map((d) => [itens[Number(d.index)].r, { decision: d.decision, reason: String(d.reason || '').slice(0, 300) }]));
            }
            res.prs[cid] = out;
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    console.log(JSON.stringify({ variante: VAR, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, comentarios: ok.reduce((s, p) => s + p.n, 0), verify: ok.reduce((s, p) => s + p.verify.length, 0), selecao: ok.reduce((s, p) => s + p.descarte.length, 0), prsComSelecao: ok.filter((p) => p.k).length, contagemErrada: ok.filter((p) => p.k && !p.contagemCerta).length }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
