#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Verify D (#1821): certificado de contradicao, depois do verify C. Por comentario:
 *   1. extrai (uma chamada, comentario + diff): ate 3 premissas necessarias, cada
 *      uma com uma pergunta neutra que nao revela a resposta que o comentario supoe;
 *   2. reconstroi as cegas (sessao nova por premissa, ferramentas no head e no
 *      base): responde a pergunta neutra sem ver o comentario;
 *   3. certifica (uma chamada): os fatos reconstruidos tornam alguma premissa falsa?
 *   4. ataca (sessao nova, ferramentas): o certificado tem lacuna?
 * Derruba so com certificado != none, ataque "valid" e, para ausencia/invariante,
 * cobertura completa. Roda so nos grupos que o verify C manteve.
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/verify/verifyD.js --model=<gold model> [--versao=d1] [--prs=arquivo] [--par=3]
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
const GOLD = arg('model'), VERSAO = arg('versao', 'd1'), PAR = Number(arg('par', '3')), DEDUP = arg('dedup', 'v9-cobertura');
const MODELO = process.env.RECALL_MODEL;
if (!GOLD || !MODELO) { console.error('RECALL_MODEL=<id> --model=<gold model>'); process.exit(2); }
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const OUT = path.join(__dirname, 'resultados', `verify-D-${VERSAO}`, `${GOLD}.json`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const SOBRE = JSON.parse(fs.readFileSync(path.join(__dirname, 'resultados', arg('sobre', 'aluc-h1t10f'), `${GOLD}.json`), 'utf8')).prs;
const SO_PRS = arg('prs') ? new Set(fs.readFileSync(arg('prs'), 'utf8').split(/\s+/).filter(Boolean)) : null;
const TETO_CEGO = Number(arg('tetoCego', '6')), TETO_ATAQUE = Number(arg('tetoAtaque', '5'));

const comentario = (s) => `<Comment>
File: ${s.relevantFile}
Lines: ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}
Label: ${s.label ?? '?'}
${String(s.suggestionContent || '').trim()}
</Comment>`;

const KINDS = ['consumer', 'reachability', 'semantics', 'ordering', 'mechanism', 'introduced'];
const S_EXTRAI = {
    type: 'object',
    properties: {
        failure: { type: 'string', description: 'The concrete failure the comment alleges, one sentence.' },
        scenario: {
            type: 'object',
            properties: {
                condition: { type: 'string', description: 'The concrete situation in which the comment says the failure happens (inputs, state, configuration).' },
                claimed_outcome: { type: 'string', description: 'What the comment says the code then does wrong.' },
                neutral_question: { type: 'string', description: 'Under that condition, what does the code do? Ask it openly, without the claimed outcome.' },
                locations: { type: 'array', items: { type: 'string' } },
            },
            required: ['condition', 'claimed_outcome', 'neutral_question', 'locations'],
            additionalProperties: false,
        },
        premises: {
            type: 'array', maxItems: 3,
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    proposition: { type: 'string', description: 'A fact about the code that must be true for the failure to happen.' },
                    kind: { type: 'string', enum: KINDS },
                    scope: { type: 'string', enum: ['repository', 'external'] },
                    neutral_question: { type: 'string', description: 'An open question whose answer settles the proposition, without stating or hinting at the answer the comment assumes.' },
                    locations: { type: 'array', items: { type: 'string' }, description: 'Files, symbols or file:line to start from.' },
                },
                required: ['id', 'proposition', 'kind', 'scope', 'neutral_question', 'locations'],
                additionalProperties: false,
            },
        },
    },
    required: ['failure', 'scenario', 'premises'],
    additionalProperties: false,
};
const pExtrai = (s, diff) => `An AI code reviewer wrote the comment below on a pull request. Do not judge it. Break it down.

${comentario(s)}

<Diff>
${diff}
</Diff>

1. State the concrete failure the comment alleges, and its scenario: the condition under which it happens, the outcome the comment claims, and a neutral question that asks what the code does under that condition without stating the claimed outcome. Example: "groups.at(0)?.rules.map() throws a TypeError when groups is empty" becomes the condition "promResponse.data.groups is an empty array" and the question "When promResponse.data.groups is an empty array, what does the expression on line 68 evaluate to, and does anything throw?".
2. List at most three premises: facts about the code that must ALL be true for that failure to happen. Prefer the premises that carry the claim: what a piece of code does when it runs (mechanism, language semantics, caching, allocation), which inputs or states can reach the cited line (reachability), which callers, implementations or consumers exist (consumer), the order in which things run (ordering), and whether the behavior is new in this pull request or was already there before it (introduced). Keep the comment's qualifications: a warning about what could happen if someone calls this later is not a claim that someone calls it now.
3. For each premise, write a neutral question for an investigator who will not see the comment. The question must be open and must not state or hint at the answer the comment assumes. Example: the premise "form() returns a new provider on every call, so attributes set earlier are lost" becomes "What does form() return when it is called twice in the same request: the same object or a new one?". The premise "no code path guarantees attendees is non-empty here" becomes "Which code paths reach line 28 of organizer-add-guests-email.ts, and what do they guarantee about the size of attendees?".
4. Mark scope "external" when the premise is about code outside this repository (third-party clients, plugins, other services).

Answer only in the requested JSON.`;

const S_CEGO = {
    type: 'object',
    properties: {
        answer: { type: 'string', description: 'Direct answer to the question.' },
        facts: { type: 'array', items: { type: 'object', properties: { statement: { type: 'string' }, evidence: { type: 'string', description: 'file:line and the quoted code' } }, required: ['statement', 'evidence'], additionalProperties: false } },
        coverage_complete: { type: 'boolean', description: 'true only if you examined every relevant path, caller or implementation, not a sample.' },
        unresolved: { type: 'array', items: { type: 'string' }, description: 'Paths, callers or questions you could not settle.' },
    },
    required: ['answer', 'facts', 'coverage_complete', 'unresolved'],
    additionalProperties: false,
};
const pCego = (p) => `You are investigating a code repository at a pull request's head commit. Answer one question from the code, nothing else.

Question: ${p.neutral_question}
Start from: ${(p.locations || []).join(', ') || '(search for it)'}

Use grep, readFile and listDir on the head commit${p.kind === 'introduced' ? ', and readBaseFile to read a file as it was before the pull request' : ''}. Report what the code shows, with file:line and quoted code for every fact. Say what you could not settle in unresolved. Set coverage_complete to true only when you examined every relevant path, caller or implementation. You have at most ${TETO_CEGO} steps in total. Answer with submit.`;

const CERTS = ['outcome', 'direct', 'closed_world_absence', 'invariant', 'ordering', 'pre_existing', 'none'];
const S_CERT = {
    type: 'object',
    properties: {
        premise_id: { type: 'string' },
        certificate: { type: 'string', enum: CERTS },
        evidence: { type: 'string', description: 'file:line and quoted code, from the investigation findings.' },
        coverage_complete: { type: 'boolean' },
        explanation: { type: 'string' },
    },
    required: ['premise_id', 'certificate', 'evidence', 'coverage_complete', 'explanation'],
    additionalProperties: false,
};
const pCert = (s, ex, cegos, cenario) => `A code review comment claims a failure and rests on the premises below. Independent investigators, who did not see the comment, answered neutral questions about the code. Decide whether their findings prove that the claimed failure does not happen, or that one premise is false.

${comentario(s)}

Alleged failure: ${ex.failure}

<Scenario id="scenario">
Condition: ${ex.scenario?.condition || '?'}
Claimed outcome: ${ex.scenario?.claimed_outcome || '?'}
<Investigation question="${ex.scenario?.neutral_question || ''}">
${JSON.stringify(cenario || { answer: 'not investigated' }, null, 1)}
</Investigation>
</Scenario>

${ex.premises.map((p, k) => `<Premise id="${p.id}" kind="${p.kind}">
${p.proposition}
<Investigation question="${p.neutral_question}">
${JSON.stringify(cegos[k] || { answer: 'not investigated' }, null, 1)}
</Investigation>
</Premise>`).join('\n\n')}

Certificates:
- "outcome": the scenario investigation traced the code under the stated condition and found, with quoted code, that it does not produce the claimed outcome (premise_id "scenario").
- "direct": quoted code states the opposite of the premise (a value, a return, a type, a guard that is there).
- "closed_world_absence": the premise needs a caller, implementation or consumer, and the investigation examined all of them (coverage_complete) and none has the property.
- "invariant": every path that reaches the cited code enforces a condition that rules out the failure, and the investigation covered every path.
- "ordering": the code fixes an order of operations that rules out the failure.
- "pre_existing": the same behavior, under the same conditions, was already in the code before this pull request, and nothing in the pull request newly enables it.
- "none": the findings do not prove any premise false. Use it when the findings agree with the premises, are partial, or only make the failure seem unlikely.

Not proof: the failure seeming unlikely, no caller triggering it today in code that is new or exported, small impact, a missing test. A premise about external code cannot be disproved from this repository. When in doubt, answer "none". Answer only in the requested JSON.`;

const S_ATAQUE = {
    type: 'object',
    properties: {
        assessment: { type: 'string', enum: ['valid', 'invalid', 'unknown'] },
        gap: { type: 'string' },
        evidence: { type: 'string' },
    },
    required: ['assessment', 'gap', 'evidence'],
    additionalProperties: false,
};
const pAtaque = (s, c) => `A code review comment is about to be discarded because a proof says one of its premises is false. Audit the proof, not the comment's importance.

${comentario(s)}

<Proof certificate="${c.certificate}">
${c.explanation}
Evidence: ${c.evidence}
</Proof>

Check the cited code with grep, readFile and listDir. Look for a concrete gap: an entry point, caller or implementation the proof missed; a guard that can be bypassed; code the pull request changed that newly enables the failure; misread semantics; or a premise the comment does not actually need, so that disproving it leaves the reported problem standing.

Answer "valid" when the proof holds and the reported problem does not exist, "invalid" when you found a gap (describe it with file:line), "unknown" when you could not check. You have at most ${TETO_ATAQUE} steps in total. Answer with submit.`;

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
    const ex = await umTiro(model, 'decompose', S_EXTRAI, pExtrai(s, diff));
    const prem = (ex?.premises || []).filter((p) => p.scope !== 'external').slice(0, 3);
    if (!prem.length) return { nit: false, etapa: 'sem premissa', ex };
    const ex2 = { ...ex, premises: prem };
    const cen = ex.scenario?.neutral_question ? { neutral_question: `Situation: ${ex.scenario.condition}\n${ex.scenario.neutral_question}`, locations: ex.scenario.locations, kind: 'scenario' } : null;
    const falha = (e) => ({ answer: 'error', erro: String(e?.message || e).slice(0, 200) });
    const [cenario, ...cegos] = await Promise.all([cen ? loop(model, pCego(cen), S_CEGO, cmd, null, TETO_CEGO).catch(falha) : null,
        ...prem.map((p) => loop(model, pCego(p), S_CEGO, cmd, p.kind === 'introduced' ? baseCtx : null, TETO_CEGO).catch(falha))]);
    const cert = await umTiro(model, 'certificate', S_CERT, pCert(s, ex2, cegos, cenario));
    const exigeCob = ['closed_world_absence', 'invariant'].includes(cert?.certificate);
    if (!cert || cert.certificate === 'none' || (exigeCob && !cert.coverage_complete)) return { nit: false, etapa: 'certificado', ex: ex2, cenario, cegos, cert };
    const at = await loop(model, pAtaque(s, cert), S_ATAQUE, cmd, null, TETO_ATAQUE);
    return { nit: at?.assessment === 'valid', etapa: 'ataque', ex: ex2, cenario, cegos, cert, ataque: at };
}


(async () => {
    const model = buildModel(MODELO);
    console.log(`[verify-D] ${VERSAO} · ${descreveModelo(MODELO)} · ${GOLD}`);
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
            const gs = grupos(sug[cid].suggestions, fin[cid], real[cid].idsEntradaDedup || []).filter((g) => !jaCaiu.has(g.rep));
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
