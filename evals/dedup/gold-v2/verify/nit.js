#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Verify depois do dedup (#1821), versao 1: so pergunta se o comentario e nit.
 * Um comentario por vez, sem o diff, com a saida enxuta da sugestao (arquivo,
 * linhas, label, texto) e ate 3 passos de grep/readFile/listDir no commit do
 * PR. Entrada: os grupos do dedup congelado (representante = texto mais
 * completo, como avaliador/nota.js).
 *
 * Versoes: v1/v2 (so o comentario, loop), v3 (nit detalhado com exemplos,
 * loop), v3d (v3 com o diff), mesa1 (teste de mesa, uma chamada com o diff),
 * mesaL (teste de mesa, loop com o diff; remove so not_bug).
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/verify/nit.js --model=<gold model> [--versao=v1] [--par=3]
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const INV = path.join(__dirname, '..', '..', '..', 'investigation');
const { buildModel, descreveModelo } = require(path.join(INV, 'eval-model'));
const { extraiJson, chamadaEstruturada } = require(path.join(INV, 'eval-structured'));
const { prepareRepo } = require(path.join(INV, 'prepare-repo'));
const { LocalRepoCommands } = require(path.join(INV, 'local-repo-commands'));

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
// --prefixo: outro conjunto de PRs (ex.: holdout) no lugar do light de 09/10.
const PREFIXO = arg('prefixo', '09.10.26');
const GOLD = arg('model'), VERSAO = arg('versao', 'v1'), PAR = Number(arg('par', '3')), DEDUP = arg('dedup', 'v9-cobertura');
const TETO = 3;
const MODELO = process.env.RECALL_MODEL;
if (!GOLD || !MODELO) { console.error('RECALL_MODEL=<id> --model=<gold model>'); process.exit(2); }
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const OUT = path.join(__dirname, 'resultados', arg('saida', `nit-${VERSAO}`), `${GOLD}.json`);
// --so1: julga so os grupos de um membro que o verify --sobre manteve.
const SO1 = arg('so1') === '1';
const SOBRE = SO1 ? JSON.parse(fs.readFileSync(path.join(__dirname, 'resultados', arg('sobre', 'aluc-h1t10f'), `${GOLD}.json`), 'utf8')).prs : null;
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const MESA = VERSAO.startsWith('mesa');
const LOOP = VERSAO !== 'mesa1';
const COM_DIFF = MESA || VERSAO === 'v3d';
const SCHEMA_MESA = {
    type: 'object',
    properties: {
        verdict: { type: 'string', enum: ['bug', 'not_bug', 'unsure'] },
        inputs: { type: 'string', description: 'The concrete inputs or state you traced.' },
        reason: { type: 'string', description: 'One sentence.' },
    },
    required: ['verdict', 'inputs', 'reason'],
    additionalProperties: false,
};
const SCHEMA = {
    type: 'object',
    properties: {
        nit: { type: 'boolean', description: 'true if the comment is a nit' },
        reason: { type: 'string', description: 'One sentence.' },
    },
    required: ['nit', 'reason'],
    additionalProperties: false,
};

const comentario = (s) => `<Comment>
File: ${s.relevantFile}
Lines: ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}
Label: ${s.label ?? '?'}
${String(s.suggestionContent || '').trim()}
</Comment>`;

// v2: o DeepSeek usava as ferramentas para concluir "nenhum chamador produz
// esse caso" e chamava bug concreto de programacao defensiva. Decidir se o
// caso acontece nao e pergunta deste verify.
const promptV2 = (s) => `An AI code reviewer wants to post the comment below on a pull request. Your only job is to decide whether this comment is a nit.

${comentario(s)}

A nit asks for a change without describing a failure: the comment itself does not say what goes wrong. Nits include:
- defensive programming "just in case": add a null check, a validation, a guard, a try/catch or a fallback, without naming a concrete input or path that makes the code fail;
- speculative concerns: "could break if", "may cause issues later", "consider what happens when", with no concrete failure described;
- style, naming, formatting, readability, comments, logging, dead code, refactoring or small simplifications;
- requests to add tests or more test coverage;
- best practices and optional improvements.

A comment is NOT a nit when it describes a concrete failure: a crash, an exception, a wrong result, lost or corrupted data, a security hole, a race condition, a broken contract between the changed code and its callers, a real performance cost, or documentation that states something false about the code. This holds even if you believe the failure cannot happen in practice: whether the failure really happens is a different question, judged by another reviewer, not by you. A comment is not a nit because it is short or because its fix is small.

You can read the repository at this pull request's commit with grep, readFile and listDir, but only to understand what the comment refers to. Do not use it to decide whether the failure is reachable. You have at most ${TETO} steps in total. Answer with submit.`;

const FERRAMENTAS = `You can read the repository at this pull request's commit with grep, readFile and listDir.`;

// v3: definicao detalhada de nit, com pares de exemplo genericos (nao copiam
// casos do benchmark). v3d = o mesmo com o diff do PR.
const promptV3 = (s, diff) => `An AI code reviewer wants to post the comment below on a pull request. Your only job is to decide whether this comment is a nit.
${diff ? `\n<Diff>\n${diff}\n</Diff>\n` : ''}
${comentario(s)}

What a nit is. In code review, a nit (short for nitpick) is a comment about something minor that the author may or may not change: the code works either way, and nothing goes wrong for users or for other code if the comment is ignored. Reviewers prefix these comments with "nit:" so the author knows they are optional.

The test: if the author ignores this comment and merges, does anything crash, return a wrong result, lose or corrupt data, open a security hole, break a caller, or mislead a reader with a false statement? If nothing does, the comment is a nit.

Common nits:
- defensive code "just in case": add a null check, a validation, a guard, a try/catch or a fallback, without naming a concrete input or path that makes the code fail;
- speculative concerns: "could break if", "may cause issues later", "consider what happens when", "if this is ever called concurrently", with no concrete failure described;
- style, naming, formatting, readability, comments, logging, dead code, refactoring, extracting helpers or constants;
- requests to add tests or more test coverage;
- best practices, consistency with other code, configurability, future-proofing, and micro-optimizations with no real cost.

Each pair below shows a nit and a comment on the same topic that is not a nit:

1. Nit: "Consider checking that items is not null before iterating."
   Not a nit: "items is null when the request has no body, because the handler passes req.body?.items straight through, and the loop on line 40 then throws a TypeError."
2. Nit: "This function is getting long; consider extracting the validation into a helper."
   Not a nit: "The validation moved into validate() no longer runs for PUT requests, because the new router only calls it on POST."
3. Nit: "The docstring could mention that the timeout is in seconds."
   Not a nit: "The docstring says the timeout is in seconds, but the code divides it by 1000, so callers passing seconds get a timeout 1000 times too short."
4. Nit: "Use a named constant instead of the magic number 3."
   Not a nit: "The retry loop uses <= 3, so it makes four attempts while the setting says three."
5. Nit: "This could become a race condition if the method is ever called from several threads."
   Not a nit: "Both workers read count, add one and write it back without a lock, so two jobs finishing at the same time lose an increment."
6. Nit: "Add a test for the empty-list case."
   Not a nit: "An empty list makes average() divide by zero and return NaN, which is then saved to the report."

A comment that describes a concrete failure is not a nit even if you believe the failure cannot happen in practice: whether it really happens is a different question, judged by another reviewer, not by you. A comment is not a nit because it is short or because its fix is small.

${FERRAMENTAS} Use it only to understand what the comment refers to, not to decide whether the failure is reachable. You have at most ${TETO} steps in total. Answer with submit.`;

// mesa: teste de mesa. mesa1 = uma chamada com o diff; mesaL = loop com o diff.
const promptMesa = (s, diff, loop) => `An AI code reviewer wants to post the comment below on a pull request. Check whether it reports a real problem by doing a desk check: trace the code by hand.

<Diff>
${diff}
</Diff>

${comentario(s)}

How to do the desk check:
1. Identify the failure the comment claims: what goes wrong, and where.
2. Choose concrete inputs or state that should trigger it, following what the comment describes: argument values, the request, database rows, configuration.
3. Walk through the code line by line with those inputs, writing down the values as they change, until you reach the line the comment points to.
4. Say whether the claimed failure happens.

Answer with one verdict:
- "bug": your trace reaches the failure. The problem is real.
- "not_bug": your trace shows the code does not fail (the case is already handled, or the input cannot reach that line through the code you traced), or the comment does not describe any failure at all: a style remark, a "just in case" check, a request for more tests, an optional improvement.
- "unsure": the trace depends on code or data you cannot see, or you could not settle it.

When in doubt, answer "unsure". If the comment says that documentation or a code comment states something false, check the statement against the code: if the statement is false, that is "bug".
${loop ? `\n${FERRAMENTAS} Use it to follow the code the trace passes through outside the diff. You have at most ${TETO} steps in total. Answer with submit.` : '\nAnswer with submit.'}`;

const promptV1 = (s) => `An AI code reviewer wants to post the comment below on a pull request. Your only job is to decide whether this comment is a nit.

<Comment>
File: ${s.relevantFile}
Lines: ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}
Label: ${s.label ?? '?'}
${String(s.suggestionContent || '').trim()}
</Comment>

A nit asks for a change but points to no defect in what the code does: the code behaves correctly as written, and the change is optional. Nits include:
- defensive programming: a null check, validation, guard, try/catch or fallback for a case the code's callers do not produce, or that is already handled elsewhere;
- speculative concerns: "could break if", "may cause issues later", "consider what happens when", with no concrete input that reaches the problem in this code;
- style, naming, formatting, readability, comments, logging, refactoring or small simplifications;
- requests to add tests or more test coverage;
- best practices and optional improvements that do not fix wrong behavior.

A comment is NOT a nit when it describes wrong behavior that actually happens: a crash, a wrong result, lost or corrupted data, a security hole, a race condition, a broken contract between the changed code and its callers, a real performance problem, or documentation that states something false about the code. A comment is not a nit because it is short or because its fix is small.

Do not judge whether the comment is correct. Judge only this: if what it describes is true, is it a defect or a nit?

You can check the repository at this pull request's commit with grep, readFile and listDir, for example to see whether any caller can actually produce the case the comment worries about. You have at most ${TETO} steps in total. Answer with submit.`;

function grupos(sugs, final, entrada) {
    const chegou = new Set(entrada);
    const porGrupo = {};
    const out = [];
    for (const s of sugs) {
        if (!chegou.has(s.id)) continue;
        const g = final[s.id]?.grupo;
        if (g) (porGrupo[g] = porGrupo[g] || []).push(s); else out.push([s]);
    }
    out.push(...Object.values(porGrupo));
    return out.map((m) => {
        const rep = m.reduce((a, b) => (String(b.suggestionContent).length > String(a.suggestionContent).length ? b : a));
        return { rep: rep.id, membros: m.map((x) => x.id), s: rep };
    });
}

function ferramentas(cmd) {
    return {
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
            execute: async ({ pattern, path: p, glob }) => String(await cmd.grep(pattern, p, glob)).slice(0, 6000),
        }),
        readFile: tool({
            description: 'Read a file, optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => { const t = String(await cmd.read(p, startLine, endLine)); const b = Number(startLine) > 0 ? Number(startLine) : 1; return t.split('\n').map((l, k) => `${b + k}: ${l}`).join('\n').slice(0, 12000); },
        }),
        listDir: tool({
            description: 'List a directory of the repository.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, maxDepth: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, maxDepth }) => String(await cmd.listDir(p, maxDepth)).slice(0, 6000),
        }),
    };
}

const textoDe = (s, diff) =>
    VERSAO === 'v1' ? promptV1(s) : VERSAO === 'v2' ? promptV2(s) : VERSAO.startsWith('v3') ? promptV3(s, COM_DIFF ? diff : '') : promptMesa(s, diff, LOOP);

/** nit = o que este verify removeria: nit (v1-v3) ou not_bug (mesa). */
function normaliza(d) {
    if (MESA) {
        if (!['bug', 'not_bug', 'unsure'].includes(d?.verdict)) throw new Error('sem resposta');
        return { nit: d.verdict === 'not_bug', verdict: d.verdict, inputs: d.inputs || '', reason: d.reason || '' };
    }
    if (typeof d?.nit !== 'boolean') throw new Error('sem resposta');
    return { nit: d.nit, reason: d.reason || '' };
}

// Claude por assinatura: sessao do Agent SDK com Read/Grep/Glob no worktree, JSON no fim.
const TIER0 = require(path.join(INV, '..', 'shared', 'tier0-models')).TIER0;
const PELO_SDK = TIER0[MODELO]?.provider === 'claude_agent_sdk';
async function julgaSdk(s, diff, dir, schema) {
    const { carregaSdk, envDoProcesso } = require(path.join(INV, 'claude-sdk-runner'));
    const sdk = await carregaSdk();
    const texto = textoDe(s, diff).replace(/grep, readFile and listDir/g, 'Grep, Read and Glob')
        .replace('Answer with submit.', `End your answer with ONLY a JSON object matching this schema, no code fence:\n${JSON.stringify(schema)}`);
    let saida = '';
    try {
        for await (const msg of sdk.query({ prompt: texto, options: {
            model: TIER0[MODELO].sdkModel,
            systemPrompt: 'You can read the repository with the Read, Grep and Glob tools; your working directory is the repository at the pull request head.',
            tools: ['Read', 'Grep', 'Glob'], allowedTools: ['Read', 'Grep', 'Glob'],
            disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
            settingSources: [], cwd: dir, maxTurns: TETO + 2, env: envDoProcesso() } })) {
            if (msg.type === 'assistant') for (const b of msg.message.content || []) if (b.type === 'text') saida += b.text + '\n';
            if (msg.type === 'result' && msg.result) saida += '\n' + msg.result;
        }
    } catch (e) { if (!saida) throw e; }
    return { ...normaliza(extraiJson(saida)), passos: 0 };
}

async function julga(model, cmd, s, diff) {
    const schema = MESA ? SCHEMA_MESA : SCHEMA;
    if (PELO_SDK && LOOP) return julgaSdk(s, diff, cmd.repoRoot, schema);
    if (!LOOP) {
        const r = await chamadaEstruturada({ model, modelId: MODELO, nome: 'submit', schema, prompt: textoDe(s, diff) });
        return { ...normaliza(r.dados), passos: 1 };
    }
    let resp = null;
    const tools = {
        ...ferramentas(cmd),
        submit: tool({ description: 'Submit your answer. Call exactly once.', inputSchema: jsonSchema(schema), execute: async (x) => { resp = x; return 'recorded'; } }),
    };
    const r = await generateText({
        model, prompt: textoDe(s, diff), tools,
        stopWhen: (x) => !!resp || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['submit'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submit' } }),
                messages: [...messages, { role: 'user', content: 'This is your final step. Call submit now, from what you already know.' }] }
            : undefined,
    });
    return { ...normaliza(resp || extraiJson(r.text || '')), passos: r.steps?.length ?? 0 };
}

(async () => {
    const model = buildModel(MODELO);
    console.log(`[verify-nit] ${VERSAO} · ${descreveModelo(MODELO)} · ${GOLD}`);
    const sug = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `${PREFIXO}_${GOLD}.json`), 'utf8')).prs;
    const fin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `${PREFIXO}_${GOLD}.final.json`), 'utf8')).prs;
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dedup-real', DEDUP, `${GOLD}.json`), 'utf8')).prs;
    const vars = {};
    for (const f of fs.readdirSync(path.join(INV, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try { const v = JSON.parse(fs.readFileSync(path.join(INV, 'datasets', f), 'utf8'))[0].vars; if (v?.caseId) vars[v.caseId] = v; } catch {}
    }
    const diffDe = (v) => { let a = v?.changedFilesFull; if (typeof a === 'string') a = JSON.parse(a); return (a || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n').slice(0, 40000); };
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { model: GOLD, verificador: MODELO, versao: VERSAO, versaoDedup: DEDUP, prs: {} };
    const fila = Object.keys(sug).filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const caiu = new Set(SO1 ? (SOBRE[cid]?.grupos || []).filter((g) => g.nit).map((g) => g.rep) : []);
            const gs = grupos(sug[cid].suggestions, fin[cid], real[cid].idsEntradaDedup || []).filter((g) => !SO1 || (g.membros.length === 1 && !caiu.has(g.rep)));
            const out = [];
            if (gs.length) {
                let cmd = null;
                if (LOOP) {
                    h = await prepareRepo(vars[cid], `${cid}-nit-${process.pid}`);
                    if (!h) throw new Error('sem repo');
                    cmd = new LocalRepoCommands(h.dir);
                }
                const diff = COM_DIFF ? diffDe(vars[cid]) : '';
                let j = 0;
                await Promise.all(Array.from({ length: 4 }, async () => {
                    while (j < gs.length) {
                        const k = j++;
                        const v = await retry(() => julga(model, cmd, gs[k].s, diff));
                        out[k] = { rep: gs[k].rep, membros: gs[k].membros, ...v };
                    }
                }));
            }
            res.prs[cid] = { grupos: out };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${gs.length} comentarios, ${out.filter((x) => x.nit).length} nit`);
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
    console.log(JSON.stringify({ versao: VERSAO, model: GOLD, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, comentarios: todos.length, nit: todos.filter((x) => x.nit).length }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }
