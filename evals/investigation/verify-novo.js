#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: dois verifies novos sobre a fila do corte de 65%. As 3 primeiras de cada
 * PR passam direto (nem sao verificadas).
 *
 *   correcao  agent loop (grep/readFile, teto 7): o modelo escreve a correcao minima
 *             (troca de um intervalo de linhas de um arquivo do head) e uma entrada
 *             concreta cujo resultado muda com ela. Checagens deterministicas: o
 *             patch aplica, fica perto das linhas citadas, e nao muda so
 *             comentario/espaco ou so texto literal (arvore do tree-sitter).
 *             Grava os sinais; a regra de derrubar e combinada offline.
 *   regras    uma chamada, sem ferramentas: diff + o arquivo citado ao redor das
 *             linhas (numerado) + regras curtas por categoria; a decisao vem antes
 *             da justificativa.
 *   entropia  semantic entropy (Farquhar et al., Nature 2024): 5 amostras
 *             independentes, sem ferramentas, de "qual e a falha concreta"; uma
 *             chamada agrupa as amostras pelo mecanismo. Grava os grupos; a regra
 *             (ex.: sem grupo de 3 das 5, cai) e combinada offline.
 *
 *   RECALL_MODEL=<id> TREE_SITTER_DIR=<dir> node verify-novo.js --variante=correcao|regras --fila=<arq> --fusao=<arq> --pool=<orig> --out=arq.json
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { prepareRepo } = require('./prepare-repo');
const { LocalRepoCommands } = require('./local-repo-commands');
const { extraiJson, chamadaEstruturada } = require('./eval-structured');
const { cosmetico } = require('./ast-cosmetico');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const Q = JSON.parse(fs.readFileSync(arg('fila'), 'utf8'));
const F = JSON.parse(fs.readFileSync(arg('fusao'), 'utf8')).prs;
const POOL = arg('pool'), OUT = arg('out'), VAR = arg('variante'), PAR = Number(arg('par', '3'));
const SO = (arg('only', '') || '').split(',').filter(Boolean);
const MODELO = process.env.RECALL_MODEL;
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
// --so-topo=N: verifica so as N primeiras de cada PR (o resto nao e publicado).
const SO_TOPO = Number(arg('so-topo', '0'));
const TOPO = 3, TETO = 7, JANELA = 80, PERTO = 15;
if (!['correcao', 'correcaotipo', 'regras', 'entropia'].includes(VAR)) throw new Error('--variante=correcao|correcaotipo|regras|entropia');
// correcaotipo: a correcao com duas flags do proprio modelo sobre o patch que escreveu.
const TIPO_FIX = VAR === 'correcaotipo';

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
function resolve(dir, todos, arquivo) {
    const rel = norm(arquivo);
    if (rel && fs.existsSync(path.join(dir, rel))) return rel;
    const achou = todos.filter((f) => f === rel || f.endsWith('/' + rel));
    return achou.length === 1 ? achou[0] : null;
}

// ---------- correcao ----------
const SYSTEM_CORRECAO = `You check ONE code review finding on a pull request by FIXING it.

Read the code with the tools. Then write the smallest change to the code at the pull request head that fixes the problem the finding describes, as a replacement of a contiguous range of lines in one file. Then give one concrete input or state for which the observable result of the program changes with your fix: what it is now, and what it is after the fix.

If, after reading the code, no change is needed — the problem cannot happen, it is already handled, or fixing it would not change any observable result — set fixNeeded to false.

Use the exact line numbers shown by readFile. newCode replaces lines startLine..endLine entirely, with the original indentation.`;
const SUBMIT_CORRECAO = {
    type: 'object',
    properties: {
        fixNeeded: { type: 'boolean' },
        fix: { type: 'object', properties: { file: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' }, newCode: { type: 'string' } }, required: ['file', 'startLine', 'endLine', 'newCode'] },
        behaviorChange: { type: 'object', properties: { input: { type: 'string' }, resultNow: { type: 'string' }, resultAfterFix: { type: 'string' } }, required: ['input', 'resultNow', 'resultAfterFix'] },
        reason: { type: 'string' },
        ...(TIPO_FIX ? {
            onlyCommentsOrWhitespace: { type: 'boolean', description: 'About your fix: true only if the ONLY differences are in code comments, whitespace or line breaks. Any change to executable code makes it false.' },
            onlyStringText: { type: 'boolean', description: 'About your fix: true only if the ONLY differences are inside string literals (the text between quotes), whatever the string is used for: log message, error message, user-facing text, translation key. If anything outside the quotes changes (a call, a variable, an operator, a new line of code, an interpolated expression), it is false.' },
        } : {}),
    },
    required: ['fixNeeded', 'reason', ...(TIPO_FIX ? ['onlyCommentsOrWhitespace', 'onlyStringText'] : [])],
};
const promptCorrecao = (c, diff) => `<PullRequestDiff>
${diff}
</PullRequestDiff>

File: ${c.relevantFile}
Lines: ${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? c.relevantLinesStart ?? '?'}
Finding: ${c.suggestionContent}

You have up to ${TETO} steps. The LAST one is your answer — submitting is itself a step — so you have up to ${TETO - 1} to read code with.
Submit with submitFix: {"fixNeeded": true|false, "fix": {"file": "...", "startLine": n, "endLine": n, "newCode": "..."}, "behaviorChange": {"input": "...", "resultNow": "...", "resultAfterFix": "..."}, "reason": "..."${TIPO_FIX ? ', "onlyCommentsOrWhitespace": true|false, "onlyStringText": true|false' : ''}}. fix and behaviorChange are required when fixNeeded is true.${TIPO_FIX ? ' About your own fix: onlyCommentsOrWhitespace is true only if the ONLY differences are in code comments, whitespace or line breaks. Any change to executable code makes it false. onlyStringText is true only if the ONLY differences are inside string literals (the text between quotes), whatever the string is used for: log message, error message, user-facing text, translation key. If anything outside the quotes changes (a call, a variable, an operator, a new line of code, an interpolated expression), it is false.' : ''}`;

function ferramentas(cmd, lidos) {
    return {
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
            execute: async ({ pattern, path: p, glob }) => { try { return String(await cmd.grep(pattern, p, glob)).slice(0, 6000); } catch (e) { return `grep failed: ${String(e.message || e).slice(0, 120)}`; } },
        }),
        readFile: tool({
            description: 'Read a file, optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => { lidos.push(p); try { const t = String(await cmd.read(p, startLine, endLine)); const b = Number(startLine) > 0 ? Number(startLine) : 1; return t.split('\n').map((l, k) => `${b + k}: ${l}`).join('\n').slice(0, 12000); } catch (e) { return `readFile failed: ${String(e.message || e).slice(0, 120)}`; } },
        }),
    };
}

async function confereFix(dir, todos, c, fix) {
    if (!fix || !fix.file || typeof fix.newCode !== 'string') return { aplica: false, motivo: 'sem-fix' };
    const rel = resolve(dir, todos, fix.file);
    if (!rel) return { aplica: false, motivo: 'arquivo-inexistente' };
    const linhas = fs.readFileSync(path.join(dir, rel), 'utf8').split('\n');
    const a = Number(fix.startLine), b = Number(fix.endLine);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a - 1 || a > linhas.length + 1) return { aplica: false, motivo: 'linhas-invalidas' };
    const antes = linhas.join('\n');
    const depois = [...linhas.slice(0, a - 1), ...fix.newCode.replace(/\n$/, '').split('\n'), ...linhas.slice(b)].join('\n');
    if (antes === depois) return { aplica: false, motivo: 'sem-mudanca' };
    const cRel = resolve(dir, todos, c.relevantFile);
    const ci = Number(c.relevantLinesStart), cf = Number(c.relevantLinesEnd) || ci;
    const mesmoArquivo = !!cRel && cRel === rel;
    const perto = mesmoArquivo && Number.isFinite(ci) && a <= cf + PERTO && b >= ci - PERTO;
    let cos = null;
    try { cos = await cosmetico(rel, antes, depois); } catch { cos = null; }
    return { aplica: true, arquivo: rel, mesmoArquivo, perto, soComentario: cos ? cos.soComentario : null, soTexto: cos ? cos.soTexto : null };
}

// Claude por assinatura: a fachada do Agent SDK nao faz chamada de ferramenta; a
// sessao roda no proprio Agent SDK com Read/Grep/Glob e a resposta em JSON no fim.
const PELO_SDK = require('../shared/tier0-models').TIER0[MODELO]?.provider === 'claude_agent_sdk';
// O codigo do patch pode ter chaves desbalanceadas dentro da string: o casamento
// de chaves precisa pular o conteudo das strings JSON.
function jsonComCodigo(texto) {
    const t = String(texto || '').replace(/```(?:json)?/gi, '');
    let ultimo = null;
    for (let i = t.indexOf('{'); i >= 0; i = t.indexOf('{', i + 1)) {
        let nivel = 0, str = false, esc = false;
        for (let j = i; j < t.length; j++) {
            const ch = t[j];
            if (str) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') str = false; continue; }
            if (ch === '"') str = true;
            else if (ch === '{') nivel++;
            else if (ch === '}' && --nivel === 0) { try { ultimo = JSON.parse(t.slice(i, j + 1)); } catch {} i = j; break; }
        }
    }
    return ultimo;
}

async function sessaoCorrecaoSdk(dir, todos, c, diff) {
    const { carregaSdk, envDoProcesso } = require('./claude-sdk-runner');
    const sdk = await carregaSdk();
    const texto = promptCorrecao(c, diff).replace(/Submit with submitFix: /, 'End your answer with ONLY this JSON object, no code fence: ');
    const opcoes = {
        model: require('../shared/tier0-models').TIER0[MODELO].sdkModel,
        systemPrompt: SYSTEM_CORRECAO.replace('readFile', 'Read') + '\n\nYou can read the repository with the Read, Grep and Glob tools; your working directory is the repository at the pull request head.',
        allowedTools: ['Read', 'Grep', 'Glob'],
        disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
        settingSources: [], cwd: dir, env: envDoProcesso(),
    };
    let saida = '', turnos = 0, sid = null, final = '';
    const corre = async (prompt, extra) => {
        try {
            for await (const msg of sdk.query({ prompt, options: { ...opcoes, ...extra } })) {
                if (msg.session_id) sid = msg.session_id;
                if (msg.type === 'assistant') { turnos++; for (const b of msg.message.content || []) if (b.type === 'text') saida += b.text + '\n'; }
                if (msg.type === 'result' && msg.result) { final = msg.result; saida += '\n' + msg.result; }
            }
        } catch (e) {
            // O SDK lanca ao bater o maxTurns depois de ja ter devolvido as mensagens.
            if (!sid) throw e;
        }
    };
    // O resultado final repete o ultimo texto do assistente; dois JSONs colados nao parseiam.
    const le = () => jsonComCodigo(final) || jsonComCodigo(saida);
    await corre(texto, { tools: ['Read', 'Grep', 'Glob'], maxTurns: TETO - 1 });
    let enviado = le();
    // Passo final forcado, como no AI SDK: retoma a sessao sem ferramentas e pede so o JSON.
    if ((!enviado || typeof enviado.fixNeeded !== 'boolean') && sid) {
        saida = ''; final = '';
        await corre('Final step: answer now from what you already read, with ONLY the JSON object described above, no code fence.', { resume: sid, tools: [], allowedTools: [], maxTurns: 1 });
        enviado = le();
    }
    if (process.env.DEBUG_SDK && (!enviado || typeof enviado.fixNeeded !== 'boolean')) fs.appendFileSync(process.env.DEBUG_SDK, `=== ${c.relevantFile} sid=${sid}\n${saida}\n`);
    return fechaCorrecao(enviado, turnos, dir, todos, c);
}

async function fechaCorrecao(enviado, passos, dir, todos, c) {
    if (!enviado || typeof enviado.fixNeeded !== 'boolean') return { temVeredito: false, passos };
    const bc = enviado.behaviorChange || null;
    const comportamento = !!bc && [bc.input, bc.resultNow, bc.resultAfterFix].every((x) => String(x || '').trim()) && String(bc.resultNow).trim() !== String(bc.resultAfterFix).trim();
    return {
        temVeredito: true, passos, fixNeeded: enviado.fixNeeded,
        checagem: enviado.fixNeeded ? await confereFix(dir, todos, c, enviado.fix) : null,
        comportamento, behaviorChange: bc, fix: enviado.fix || null, reason: String(enviado.reason || '').slice(0, 400),
        ...(TIPO_FIX ? { onlyCommentsOrWhitespace: enviado.onlyCommentsOrWhitespace === true, onlyStringText: enviado.onlyStringText === true } : {}),
    };
}

async function sessaoCorrecao(model, cmd, dir, todos, c, diff) {
    if (PELO_SDK) return sessaoCorrecaoSdk(dir, todos, c, diff);
    let enviado = null;
    const lidos = [];
    const tools = { ...ferramentas(cmd, lidos), submitFix: tool({ description: 'Submit your fix and verdict. The only way to answer.', inputSchema: jsonSchema(SUBMIT_CORRECAO), execute: async (x) => { enviado = x; return 'recorded'; } }) };
    const r = await generateText({
        model, system: SYSTEM_CORRECAO, prompt: promptCorrecao(c, diff), tools,
        stopWhen: (x) => !!enviado || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['submitFix'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submitFix' } }),
                messages: [...messages, { role: 'user', content: 'Final step: submit your fix now, from what you already read. If you could not finish, give your best fix.' }] }
            : undefined,
    });
    if (!enviado) enviado = extraiJson(r.text || '');
    if (!enviado || typeof enviado.fixNeeded !== 'boolean') return { temVeredito: false, passos: r.steps?.length ?? 0 };
    const bc = enviado.behaviorChange || null;
    const comportamento = !!bc && [bc.input, bc.resultNow, bc.resultAfterFix].every((x) => String(x || '').trim()) && String(bc.resultNow).trim() !== String(bc.resultAfterFix).trim();
    return {
        temVeredito: true, passos: r.steps?.length ?? 0, fixNeeded: enviado.fixNeeded,
        checagem: enviado.fixNeeded ? await confereFix(dir, todos, c, enviado.fix) : null,
        comportamento, behaviorChange: bc, fix: enviado.fix || null, reason: String(enviado.reason || '').slice(0, 400),
    };
}

// ---------- regras ----------
const REGRAS = `Rules by category. Each says when a finding of that category IS a defect worth fixing before merge, and when it is NOT.

null-missing (null, undefined, nil, empty, missing key/field)
- IS: a value the code can really receive as null/missing (optional field, failed lookup, external input, nullable column) reaches a dereference or use without a check on that path.
- NOT: the value is guaranteed by a type, schema, constructor, validation, framework or an earlier check/return on every path; or it only matters if a caller misuses the API in a way no caller does.

error-handling (exceptions, failed calls, rejected promises, error codes)
- IS: a failure that can really happen (I/O, network, parsing external data, DB) is swallowed, mis-reported, leaves state half-updated, or crashes a path that should survive.
- NOT: asks for try/catch, logging or retries "just in case" where the error is already handled upstream, cannot occur, or propagating it is the intended behavior.

concurrency (races, ordering, async, locks, shared state)
- IS: two operations the code really runs concurrently (parallel requests, workers, async without await, shared mutable state) can interleave and produce a wrong or lost result.
- NOT: a theoretical race with no concurrent caller in this code, protected by a lock/transaction/unique constraint/single-threaded runtime, or with a harmless outcome.

security (authn/authz, injection, secrets, validation of untrusted input, exposure)
- IS: untrusted input reaches a sensitive operation, a permission check is missing/wrong on a reachable path, or sensitive data is exposed.
- NOT: the input is trusted or already validated/escaped, the path is internal-only, or it is hardening advice with no concrete exploit in this code.

data-integrity (persistence, transactions, migrations, consistency, caching)
- IS: a reachable path writes wrong data, loses data, leaves records inconsistent, or serves stale/wrong cached data.
- NOT: speculative scale or edge cases the data model rules out, or a consistency the system does not need.

logic (wrong value, wrong condition, off-by-one, wrong branch, regression vs the previous code)
- IS: for an input the code really receives, the result differs from what the code, its name, its tests or the PR intends.
- NOT: the reviewer misread the code, the "wrong" case cannot occur, or it is a different but equally valid choice.

api-contract (signatures, types, return shapes, compatibility, callers)
- IS: a change breaks a real caller, a public contract or a serialized format.
- NOT: no caller is affected, or the change is the intended new contract updated everywhere.

resource-performance (leaks, unbounded work, N+1, blocking)
- IS: a reachable path leaks a resource, grows without bound, or does work that is clearly excessive for the real input sizes.
- NOT: micro-optimizations, or costs that only matter at scales this code never sees.

tests (the finding is about test code or test coverage)
- IS: a test that passes while the code under test is wrong, or a test that is broken/flaky in a way that hides a defect.
- NOT: asks for more tests, better names, or more assertions without a hidden defect.

style-maintainability (naming, comments, docs, formatting, dead code, duplication, log wording, readability)
- Never a defect: keep = false.

When the finding fits none of these, judge it by the logic rule. Decide from the code shown, not from how confident the finding sounds.`;
const SCHEMA_REGRAS = {
    type: 'object',
    properties: {
        keep: { type: 'boolean' },
        category: { type: 'string', enum: ['null-missing', 'error-handling', 'concurrency', 'security', 'data-integrity', 'logic', 'api-contract', 'resource-performance', 'tests', 'style-maintainability'] },
        reason: { type: 'string', description: 'One or two sentences, citing file:line, AFTER the decision.' },
    },
    required: ['keep', 'category', 'reason'],
    additionalProperties: false,
};
const regrasTool = tool({ description: 'Record the decision. Call exactly once.', inputSchema: jsonSchema(SCHEMA_REGRAS), execute: async () => ({ output: 'ok' }) });
const promptRegras = (c, diff, trecho) => `You decide whether ONE code review finding on a pull request should be posted. Answer with the decision FIRST (keep), then the category, then a short reason.

${REGRAS}

<PullRequestDiff>
${diff}
</PullRequestDiff>

<CitedCode file="${c.relevantFile}" note="pull request head, numbered">
${trecho}
</CitedCode>

Finding (${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? c.relevantLinesStart ?? '?'}):
${c.suggestionContent}

keep = true when the finding is a defect by the rule of its category; false otherwise.`;

function trechoCitado(dir, todos, c) {
    const rel = resolve(dir, todos, c.relevantFile);
    if (!rel) return '(file not found at the pull request head)';
    const linhas = fs.readFileSync(path.join(dir, rel), 'utf8').split('\n');
    const ci = Number(c.relevantLinesStart) || 1, cf = Number(c.relevantLinesEnd) || ci;
    const a = Math.max(1, ci - JANELA), b = Math.min(linhas.length, cf + JANELA);
    return linhas.slice(a - 1, b).map((l, k) => `${a + k}: ${l}`).join('\n');
}

async function sessaoRegras(model, dir, todos, c, diff) {
    const r = await chamadaEstruturada({ model, modelId: MODELO, nome: 'regras', schema: SCHEMA_REGRAS, toolDef: regrasTool, prompt: promptRegras(c, diff, trechoCitado(dir, todos, c)) });
    const d = r.dados;
    if (!d || typeof d.keep !== 'boolean') throw new Error('sem decisao');
    return { temVeredito: true, keep: d.keep, category: d.category, reason: String(d.reason || '').slice(0, 400) };
}

// ---------- entropia ----------
const AMOSTRAS = 5;
const promptExplica = (c, diff, trecho) => `<PullRequestDiff>
${diff}
</PullRequestDiff>

<CitedCode file="${c.relevantFile}" note="pull request head, numbered">
${trecho}
</CitedCode>

A code review finding on this pull request (${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? c.relevantLinesStart ?? '?'}):
${c.suggestionContent}

In at most three sentences, state the concrete failure, from the code: the trigger (the input, state or call sequence that causes it), where it goes wrong (file:line), and the wrong result. If you find no such failure in the code, answer "NONE:" followed by why.`;
const SCHEMA_GRUPOS = {
    type: 'object',
    properties: { groups: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'Each group lists the indices of explanations that describe the same failure mechanism.' } },
    required: ['groups'],
    additionalProperties: false,
};
const gruposTool = tool({ description: 'Record the groups. Call exactly once.', inputSchema: jsonSchema(SCHEMA_GRUPOS), execute: async () => ({ output: 'ok' }) });
const promptGrupos = (xs) => `Below are ${xs.length} independent explanations of the same code review finding. Group them by the failure mechanism they describe: two explanations are in the same group only if they name the same trigger AND the same wrong result at the same place (wording may differ). Explanations starting with "NONE" go together in one group. Every index must appear in exactly one group.

${xs.map((x, i) => `[${i}] ${x}`).join('\n\n')}`;

async function sessaoEntropia(model, dir, todos, c, diff) {
    const p = promptExplica(c, diff, trechoCitado(dir, todos, c));
    const xs = await Promise.all(Array.from({ length: AMOSTRAS }, async () => String((await generateText({ model, prompt: p, temperature: 1 })).text || '').trim().slice(0, 1200)));
    if (xs.some((x) => !x)) throw new Error('amostra vazia');
    const r = await chamadaEstruturada({ model, modelId: MODELO, nome: 'grupos', schema: SCHEMA_GRUPOS, toolDef: gruposTool, prompt: promptGrupos(xs) });
    const gs = (r.dados?.groups || []).map((g) => [...new Set(g.map(Number))].filter((k) => k >= 0 && k < AMOSTRAS));
    const visto = new Set(gs.flat());
    if (visto.size !== AMOSTRAS || gs.flat().length !== AMOSTRAS) throw new Error('grupos invalidos');
    const none = xs.map((x) => /^\W*NONE/i.test(x));
    const tam = gs.map((g) => g.length).sort((a, b) => b - a);
    const entropia = -gs.reduce((s, g) => s + (g.length / AMOSTRAS) * Math.log(g.length / AMOSTRAS), 0);
    const maior = gs.reduce((a, g) => (g.length > a.length ? g : a), []);
    return { temVeredito: true, maior: tam[0], maiorNone: maior.length > 0 && maior.every((k) => none[k]), none: none.filter(Boolean).length, grupos: gs.length, entropia: Number(entropia.toFixed(3)), amostras: xs.map((x) => x.slice(0, 400)) };
}

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = PELO_SDK ? null : buildModel(MODELO);
    console.log(`[verify-novo] ${descreveModelo(MODELO)} · ${VAR} · ${SO_TOPO ? `so o topo ${SO_TOPO}` : `topo ${TOPO} intacto`}`);
    const vars = {}, diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            let arr = v?.changedFilesFull; if (typeof arr === 'string') arr = JSON.parse(arr);
            if (v?.caseId) { vars[v.caseId] = v; diffs[v.caseId] = (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n'); }
        } catch {}
    }
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { modelo: MODELO, variante: VAR, prs: {} };
    const fila = Object.keys(Q).filter((c) => (!SO.length || SO.includes(c)) && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const alvos = SO_TOPO ? (Q[cid] || []).slice(0, SO_TOPO) : (Q[cid] || []).slice(TOPO);
            const decis = {};
            if (alvos.length) {
                const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
                const textoDe = Object.fromEntries(F[cid].itens.map((it) => [it.rep, it.texto]));
                h = await prepareRepo(vars[cid], `${cid}-vn-${process.pid}`);
                if (!h) throw new Error('sem repo');
                const cmd = new LocalRepoCommands(h.dir);
                let todos = [];
                try { todos = execFileSync('git', ['-C', h.dir, 'ls-files'], { maxBuffer: 64 * 1024 * 1024 }).toString().split('\n'); } catch {}
                let j = 0;
                await Promise.all(Array.from({ length: 4 }, async () => {
                    while (j < alvos.length) {
                        const rep = alvos[j++];
                        const c = { ...cs[rep], suggestionContent: textoDe[rep] || cs[rep].suggestionContent, existingCode: undefined };
                        decis[rep] = await retry(() => (VAR === 'correcao' || TIPO_FIX ? sessaoCorrecao(model, cmd, h.dir, todos, c, diffs[cid]) : VAR === 'entropia' ? sessaoEntropia(model, h.dir, todos, c, diffs[cid]) : sessaoRegras(model, h.dir, todos, c, diffs[cid])));
                    }
                }));
            }
            res.prs[cid] = { topo: SO_TOPO ? [] : (Q[cid] || []).slice(0, TOPO), soTopo: SO_TOPO || undefined, decisoes: decis };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const ds = ok.flatMap((p) => Object.values(p.decisoes));
    const resumo = { variante: VAR, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, verificadas: ds.length, semVeredito: ds.filter((d) => !d.temVeredito).length };
    if (VAR === 'correcao' || TIPO_FIX) Object.assign(resumo, { ...(TIPO_FIX ? { onlyCommentsOrWhitespace: ds.filter((d) => d.onlyCommentsOrWhitespace).length, onlyStringText: ds.filter((d) => d.onlyStringText).length } : {}), semFix: ds.filter((d) => d.fixNeeded === false).length, naoAplica: ds.filter((d) => d.checagem && !d.checagem.aplica).length, longe: ds.filter((d) => d.checagem?.aplica && !d.checagem.perto).length, soComentario: ds.filter((d) => d.checagem?.soComentario).length, soTexto: ds.filter((d) => d.checagem?.soTexto).length, semComportamento: ds.filter((d) => d.fixNeeded && !d.comportamento).length });
    else if (VAR === 'entropia') { const m = {}; for (const d of ds) m[d.maior] = (m[d.maior] || 0) + 1; Object.assign(resumo, { maiorGrupo: m, maiorNone: ds.filter((d) => d.maiorNone).length }); }
    else Object.assign(resumo, { derrubadas: ds.filter((d) => d.keep === false).length });
    console.log(JSON.stringify(resumo));
    process.exit(resumo.erros ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
