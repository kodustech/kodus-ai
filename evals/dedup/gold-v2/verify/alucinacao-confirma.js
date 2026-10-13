#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Segunda etapa do verify de alucinacao (#1821): para cada comentario que uma
 * rodada de alucinacao.js refutou, uma chamada sem ferramentas le o comentario
 * e a evidencia e decide se a evidencia prova falsa uma afirmacao do comentario
 * ou so argumenta que o caso e improvavel. Remove so o primeiro.
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/verify/alucinacao-confirma.js --model=<gold model> --sobre=h1 --versao=<rotulo> [--prompt=c1]
 */
const fs = require('fs');
const path = require('path');
const INV = path.join(__dirname, '..', '..', '..', 'investigation');
const { buildModel } = require(path.join(INV, 'eval-model'));
const { chamadaEstruturada } = require(path.join(INV, 'eval-structured'));

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const GOLD = arg('model'), SOBRE = arg('sobre'), VERSAO = arg('versao'), PROMPT = arg('prompt', 'c1');
const MODELO = process.env.RECALL_MODEL;
if (!GOLD || !SOBRE || !VERSAO || !MODELO) { console.error('RECALL_MODEL=<id> --model= --sobre= --versao='); process.exit(2); }
const INS = SOBRE.split(',').map((v) => path.join(__dirname, 'resultados', `aluc-${v}`, `${GOLD}.json`));
const OUT = path.join(__dirname, 'resultados', `aluc-${VERSAO}`, `${GOLD}.json`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const SCHEMA = PROMPT === 'f1' ? {
    type: 'object',
    properties: { kind: { type: 'string', enum: ['remove', 'keep'] }, reason: { type: 'string' } },
    required: ['kind', 'reason'],
    additionalProperties: false,
} : {
    type: 'object',
    properties: { kind: { type: 'string', enum: ['contradicts', 'argues'] }, reason: { type: 'string' } },
    required: ['kind', 'reason'],
    additionalProperties: false,
};

const PROMPTS = {
    c1: (s, g) => `A code review comment was checked against the repository, and the checker says the comment rests on a false statement about the code. Decide what kind of evidence the checker found.

<Comment>
File: ${s.relevantFile}
Lines: ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}
${String(s.suggestionContent || '').trim()}
</Comment>

<Checker>
Evidence: ${g.evidence}
Reason: ${g.reason}
</Checker>

Answer "contradicts" only when the evidence quotes code in this repository that directly shows a specific statement of the comment is false: the comment says the code does X, or that X exists or is missing, and the quoted code shows otherwise.

Answer "argues" when the evidence instead:
- argues the reported failure is unlikely, unreachable today, or harmless (for example, "no caller passes that value", "the type never returns null", "only one subclass exists", "the documentation says values look different");
- relies on how a language, library, framework or external tool behaves, rather than on code in this repository;
- disagrees with the comment's conclusion without showing that one of its statements about the code is false.

When unsure, answer "argues".`,
    c2: (s, g) => `A code review comment was checked against the repository, and one or more checkers say the comment rests on a false statement about the code. Decide what kind of evidence they found.

<Comment>
File: ${s.relevantFile}
Lines: ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}
${String(s.suggestionContent || '').trim()}
</Comment>

<Checkers>
${g.refs.map((r) => `Evidence: ${r.evidence}\nReason: ${r.reason}`).join('\n---\n')}
</Checkers>

Answer "contradicts" when the evidence quotes code in this repository that shows a factual statement of the comment is false. Factual statements are about what specific code contains or does:
- what a named file, function, branch or line does, calls, imports, stores or returns;
- which callers, overrides, subclasses or definitions exist, when the comment's problem needs one to exist (a repository-wide search finding none counts);
- how this repository configures the code path the comment describes, when that setting is applied on that path.

Answer "argues" when the evidence instead:
- relies on how a language, library, framework or external tool behaves, even if another file in this repository is quoted to illustrate it;
- quotes code from a different place than the code the comment is about, as an example;
- says a type or function "never" returns the bad value, so the reported branch cannot be reached;
- relies on documentation, help text or setting descriptions about what values look like;
- argues that the comment's reading is right about the code but the behavior is intended, correct by design, or harmless.

When unsure, answer "argues".`,
    c3: (s, g) => `A code review comment was checked against the repository, and one or more checkers say the comment rests on a false statement about the code. Decide what kind of evidence they found.

<Comment>
File: ${s.relevantFile}
Lines: ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}
${String(s.suggestionContent || '').trim()}
</Comment>

<Checkers>
${g.refs.map((r) => `Evidence: ${r.evidence}\nReason: ${r.reason}`).join('\n---\n')}
</Checkers>

Answer "contradicts" when the evidence quotes code in this repository that shows a factual statement of the comment is false. Factual statements are about what specific code contains or does:
- what a named file, function, branch or line does, calls, imports, stores or returns;
- which callers, overrides, subclasses or definitions exist, when the comment's problem needs one to exist (a repository-wide search finding none counts);
- how this repository configures the code path the comment describes, when that setting is applied on that path.

Answer "argues" when the evidence instead:
- relies on how a language, library, framework or external tool behaves, even if another file in this repository is quoted to illustrate it. This includes what a command-line tool accepts as an argument, how a library converts or normalizes a value, and what syntax a language allows: quoting the repository code that passes the value along does not make it a statement about this repository;
- quotes code from a different place than the code the comment is about, as an example;
- says a type or function "never" returns the bad value, so the reported branch cannot be reached;
- relies on documentation, help text or setting descriptions about what values look like;
- argues that the comment's reading is right about the code but the behavior is intended, correct by design, or harmless;
- argues that the condition, flag, gate or check the comment calls wrong is actually the right one. Whether a gate is the right one is a judgment about intent, not a fact the code can contradict.

When unsure, answer "argues".`,
    c4: (s, g) => `A code review comment was checked against the repository, and one or more checkers say the comment rests on a false statement about the code. Decide what kind of evidence they found.

<Comment>
File: ${s.relevantFile}
Lines: ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}
${String(s.suggestionContent || '').trim()}
</Comment>

<Checkers>
${g.refs.map((r) => `Evidence: ${r.evidence}\nReason: ${r.reason}`).join('\n---\n')}
</Checkers>

Answer "contradicts" when the evidence quotes code in this repository that shows a factual statement of the comment is false. Factual statements are about what specific code contains or does:
- what a named file, function, branch or line does, calls, imports, stores or returns;
- which callers, overrides, subclasses or definitions exist, when the comment's problem needs one to exist (a repository-wide search finding none counts);
- how this repository configures the code path the comment describes, when that setting is applied on that path.

Answer "argues" when the evidence instead:
- relies on how a language, library, framework or external tool behaves, even if another file in this repository is quoted to illustrate it. This includes what a command-line tool accepts as an argument, how a library converts or normalizes a value, and what syntax a language allows: quoting the repository code that passes the value along does not make it a statement about this repository;
- quotes code from a different place than the code the comment is about, as an example;
- says a type or function "never" returns the bad value, so the reported branch cannot be reached;
- relies on documentation, help text or setting descriptions about what values look like;
- argues that the comment's reading is right about the code but the behavior is intended, correct by design, or harmless;
- argues that the condition, flag, gate or check the comment calls wrong is actually the right one. Whether a gate is the right one is a judgment about intent, not a fact the code can contradict;
- argues about which states exist at runtime: which realms, tenants or users have a feature or setting turned on, which rows or records exist, which combinations happen in deployments. Code can show what is possible, not which states actually occur.

When unsure, answer "argues".`,
    // f1: filtro unificado para o veredito unico (alucinacao.js --versao=u1).
    f1: (s, g) => g.refs[0].verdict === 'nit' ? `A code review comment was checked against the repository, and the checker says it is a nit: what it says about the code is true, but the change it asks for is optional. Decide whether the comment can be dropped as a nit.

<Comment>
File: ${s.relevantFile}
Lines: ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}
${String(s.suggestionContent || '').trim()}
</Comment>

<Checker>
Evidence: ${g.refs[0].evidence}
Reason: ${g.refs[0].reason}
</Checker>

Answer "keep" when the comment itself describes a concrete failure: a crash, an exception, a wrong result, lost or corrupted data, a security hole, a race condition, a broken contract between the changed code and its callers, a real performance cost, or documentation that states something false about the code. Keep it even if the checker believes the failure is rare, unlikely or not reachable today: whether it happens is not this decision.

Answer "remove" only when the comment names no concrete failure: it asks for a check "just in case", speculates ("could", "may", "consider"), or asks for style, naming, logging, refactoring, tests or an optional improvement.

When unsure, answer "keep".` : `A code review comment was checked against the repository, and the checker says the comment rests on a false statement about the code. Decide what kind of evidence the checker found.

<Comment>
File: ${s.relevantFile}
Lines: ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}
${String(s.suggestionContent || '').trim()}
</Comment>

<Checker>
Evidence: ${g.refs[0].evidence}
Reason: ${g.refs[0].reason}
</Checker>

Answer "remove" when the evidence quotes code in this repository that shows a factual statement of the comment is false. Factual statements are about what specific code contains or does:
- what a named file, function, branch or line does, calls, imports, stores or returns;
- which callers, overrides, subclasses or definitions exist, when the comment's problem needs one to exist (a repository-wide search finding none counts);
- how this repository configures the code path the comment describes, when that setting is applied on that path.

Answer "keep" when the evidence instead:
- relies on how a language, library, framework or external tool behaves, even if another file in this repository is quoted to illustrate it. This includes what a command-line tool accepts as an argument, how a library converts or normalizes a value, and what syntax a language allows: quoting the repository code that passes the value along does not make it a statement about this repository;
- quotes code from a different place than the code the comment is about, as an example;
- says a type or function "never" returns the bad value, so the reported branch cannot be reached;
- relies on documentation, help text or setting descriptions about what values look like;
- argues that the comment's reading is right about the code but the behavior is intended, correct by design, or harmless;
- argues that the condition, flag, gate or check the comment calls wrong is actually the right one.

When unsure, answer "keep".`,
};

(async () => {
    const model = buildModel(MODELO);
    const fontes = INS.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
    const src = fontes[0];
    const sug = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `09.10.26_${GOLD}.json`), 'utf8')).prs;
    const res = { ...src, versao: VERSAO, sobre: SOBRE, prompt: PROMPT, prs: {} };
    const tarefas = [];
    for (const [cid, p] of Object.entries(src.prs)) {
        if (p.erro) { res.prs[cid] = p; continue; }
        res.prs[cid] = { grupos: p.grupos.map((g) => {
            const refs = fontes.map((f) => f.prs[cid]?.grupos?.find((x) => x.rep === g.rep)).filter((x) => x && x.nit).map((x) => ({ verdict: x.verdict, evidence: x.evidence, reason: x.reason }));
            return { rep: g.rep, membros: g.membros, refs, nit: refs.length > 0, etapa1: refs.length > 0 };
        }) };
        res.prs[cid].grupos.forEach((g) => { if (g.nit) tarefas.push({ cid, g, s: sug[cid].suggestions.find((x) => x.id === g.rep) }); });
    }
    let i = 0, erros = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
        while (i < tarefas.length) {
            const t = tarefas[i++];
            try {
                const r = await retry(async () => { const x = await chamadaEstruturada({ model, modelId: MODELO, nome: 'submit', schema: SCHEMA, prompt: PROMPTS[PROMPT](t.s, t.g) }); if (!(PROMPT === 'f1' ? ['remove', 'keep'] : ['contradicts', 'argues']).includes(x.dados?.kind)) throw new Error('sem resposta'); return x; });
                t.g.etapa2 = r.dados; t.g.nit = r.dados.kind === (PROMPT === 'f1' ? 'remove' : 'contradicts');
            } catch (e) { erros++; t.g.etapa2 = { erro: String(e?.message || e) }; }
        }
    }));
    fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
    const todos = Object.values(res.prs).flatMap((p) => p.grupos || []);
    console.log(JSON.stringify({ versao: VERSAO, sobre: SOBRE, model: GOLD, refutadosEtapa1: tarefas.length, removidos: todos.filter((g) => g.nit).length, erros }));
    process.exit(erros ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }
