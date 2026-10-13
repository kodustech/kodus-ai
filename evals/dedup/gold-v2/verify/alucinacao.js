#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Verify de alucinacao depois do dedup (#1821): um comentario por vez, sem o
 * diff, com a saida enxuta da sugestao e um loop de grep/readFile/listDir no
 * commit do PR (--teto, padrao 6). Pergunta se o comentario se apoia num fato
 * falso sobre o codigo; remove so "refuted" com evidencia citada. Mesmos
 * grupos do dedup congelado de nit.js.
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/verify/alucinacao.js --model=<gold model> --versao=h1 [--teto=6] [--par=3]
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
const GOLD = arg('model'), VERSAO = arg('versao', 'h1'), PAR = Number(arg('par', '3')), DEDUP = arg('dedup', 'v9-cobertura');
const MODELO = process.env.RECALL_MODEL;
if (!GOLD || !MODELO) { console.error('RECALL_MODEL=<id> --model=<gold model>'); process.exit(2); }
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const OUT = path.join(__dirname, 'resultados', `aluc-${VERSAO}`, `${GOLD}.json`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const TETO = Number(arg('teto', '6'));
const VEREDITOS = VERSAO.startsWith('u') ? ['refuted', 'nit', 'confirmed', 'unverified'] : ['refuted', 'confirmed', 'unverified'];
const SCHEMA = {
    type: 'object',
    properties: {
        verdict: { type: 'string', enum: VEREDITOS },
        claim: { type: 'string', description: 'For refuted: the false sentence, copied word for word from the comment.' },
        evidence: { type: 'string', description: 'For refuted: file:line and the quoted code that contradicts the comment.' },
        reason: { type: 'string', description: 'One sentence.' },
    },
    required: ['verdict', 'claim', 'evidence', 'reason'],
    additionalProperties: false,
};

const comentario = (s) => `<Comment>
File: ${s.relevantFile}
Lines: ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}
Label: ${s.label ?? '?'}
${String(s.suggestionContent || '').trim()}
</Comment>`;

const PROMPTS = {
    h1: (s) => `An AI code reviewer wants to post the comment below on a pull request. Your only job is to check whether the comment is built on a false statement about the code.

${comentario(s)}

Review comments sometimes misread the code. They say a function is called where it is not, that a caller was not updated when it was, that a value is a per-request secret when it is a constant, that a check is missing when it is there, that a regex matches characters it does not, or that a test fails when the test setup makes it pass. Such a comment is refuted: the problem it reports does not exist, because a fact it rests on is false.

1. List the statements of fact the comment relies on: what the code at the cited lines does, what the other code it names does, which callers, files or values exist.
2. Check them in the repository at this pull request's commit with grep, readFile and listDir. Start with the cited file and lines.
3. Answer "refuted" only when you found code that contradicts a statement the reported problem depends on. Put that code, with its file and line, in evidence.

Answer "confirmed" when the statements you checked hold, and "unverified" when you could not check them. A comment is not refuted because:
- the scenario seems unlikely, or you did not find a caller that triggers it today;
- the impact seems small, or the fix is optional;
- the comment is vague, speculative or a style remark.
Those questions belong to other reviewers. When in doubt, do not answer "refuted".

You have at most ${TETO} steps in total. Answer with submit.`,
    h3: (s) => `An AI code reviewer wants to post the comment below on a pull request. Your only job is to check whether the comment states something false about the code in this repository.

${comentario(s)}

Review comments sometimes misread the code. They say a function is called where it is not, that a caller was not updated when it was, that a value is a per-request secret when it is a constant, that a check is missing when it is there, that a regex matches characters it does not, or that a test fails when the test setup makes it pass.

1. Pick the sentences of the comment that state facts about this repository's code: what the cited lines do, what the other code it names does, which callers, overrides, files, settings or values exist.
2. Check them with grep, readFile and listDir at this pull request's commit. Start with the cited file and lines, then follow the code the comment names.
3. Answer "refuted" only when you found code in this repository that shows one of those sentences is false. In claim, copy that sentence word for word from the comment. In evidence, quote the code with its file and line.

Only code in this repository counts as evidence. These do not refute a comment:
- what you know about how a language, library, framework or external tool behaves;
- documentation, comments or setting descriptions about what values usually look like;
- the scenario seeming unlikely, no caller triggering it today, or a type that "never" returns the bad value;
- small impact, an optional fix, a vague or speculative comment.

Answer "confirmed" when the sentences you checked hold, and "unverified" when you could not check them. When in doubt, do not answer "refuted".

You have at most ${TETO} steps in total. Answer with submit.`,
    // u1: um veredito so, com nit como valor; refuted e nit seguem para o filtro.
    u1: (s) => `An AI code reviewer wants to post the comment below on a pull request. Check the comment against the code in this repository and give it one verdict.

${comentario(s)}

The four verdicts:

- "refuted": the comment rests on a false statement about the code, so the problem it reports does not exist. Review comments sometimes misread the code: they say a function is called where it is not, that a caller was not updated when it was, that a value is a per-request secret when it is a constant, that a check is missing when it is there, that a regex matches characters it does not, or that a test fails when the test setup makes it pass. Use "refuted" only when you found code in this repository that contradicts a statement the reported problem depends on, and quote that code in evidence.

- "nit": what the comment says about the code is true, but the change it asks for is optional: if the author ignores it and merges, nothing crashes, returns a wrong result, loses or corrupts data, opens a security hole, breaks a caller, or misleads a reader with a false statement. Nits include:
  - defensive code "just in case": a null check, validation, guard, try/catch or fallback, with no concrete input or path that makes the code fail;
  - speculative concerns: "could break if", "may cause issues later", "consider what happens when", with no concrete failure described;
  - style, naming, formatting, readability, comments, logging, dead code, refactoring, extracting helpers or constants;
  - requests to add tests or more test coverage;
  - best practices, consistency, configurability, future-proofing, micro-optimizations with no real cost.
  For example, "Consider checking that items is not null before iterating" is a nit; "items is null when the request has no body, because the handler passes req.body?.items straight through, and the loop on line 40 then throws" is not. "Use a named constant instead of the magic number 3" is a nit; "the retry loop uses <= 3, so it makes four attempts while the setting says three" is not.

- "confirmed": the statements of the comment hold and it describes a real problem: a concrete failure, not an optional change.

- "unverified": you could not check the comment's statements.

Decide in this order. First check the facts: if a statement the problem depends on is false, the verdict is "refuted". If the facts hold, decide whether the change is optional: "nit" or "confirmed".

How to check: list the statements of fact the comment relies on (what the code at the cited lines does, what the other code it names does, which callers, files or values exist), then check them with grep, readFile and listDir at this pull request's commit, starting with the cited file and lines.

None of these makes a comment "refuted": the scenario seeming unlikely, not finding a caller that triggers it today, small impact, or a vague or speculative wording. Those are not false statements; a speculative or optional comment is a "nit" when its facts hold. When in doubt between "refuted" and anything else, do not answer "refuted".

In evidence, quote the code behind your verdict with its file and line. You have at most ${TETO} steps in total. Answer with submit.`,
};

const norm = (t) => String(t || '').toLowerCase().replace(/[`*_"'\s]+/g, ' ').trim();

/** nit = o que este verify removeria: refuted com evidencia (h3: e com a frase copiada do comentario). */
function normaliza(d, s) {
    if (!VEREDITOS.includes(d?.verdict)) throw new Error('sem resposta');
    let ok = (d.verdict === 'refuted' && String(d.evidence || '').trim().length > 0) || d.verdict === 'nit';
    let claimNoTexto = null;
    if (ok && VERSAO === 'h3') {
        const c = norm(d.claim);
        claimNoTexto = c.length >= 15 && norm(s.suggestionContent).includes(c.slice(0, 60));
        ok = claimNoTexto;
    }
    return { nit: ok, verdict: d.verdict, claim: d.claim || '', claimNoTexto, evidence: d.evidence || '', reason: d.reason || '' };
}

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

async function julga(model, cmd, s, diff) {
    const schema = SCHEMA;
    let resp = null;
    const tools = {
        ...ferramentas(cmd),
        submit: tool({ description: 'Submit your answer. Call exactly once.', inputSchema: jsonSchema(schema), execute: async (x) => { resp = x; return 'recorded'; } }),
    };
    const r = await generateText({
        model, prompt: PROMPTS[arg('prompt', VERSAO)](s, diff), tools,
        stopWhen: (x) => !!resp || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['submit'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submit' } }),
                messages: [...messages, { role: 'user', content: 'This is your final step. Call submit now, from what you already know.' }] }
            : undefined,
    });
    return { ...normaliza(resp || extraiJson(r.text || ''), s), passos: r.steps?.length ?? 0 };
}

(async () => {
    const model = buildModel(MODELO);
    console.log(`[verify-alucinacao] ${VERSAO} · ${descreveModelo(MODELO)} · ${GOLD}`);
    const sug = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `09.10.26_${GOLD}.json`), 'utf8')).prs;
    const fin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `09.10.26_${GOLD}.final.json`), 'utf8')).prs;
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
            const gs = grupos(sug[cid].suggestions, fin[cid], real[cid].idsEntradaDedup || []);
            const out = [];
            if (gs.length) {
                let cmd = null;
                {
                    h = await prepareRepo(vars[cid], `${cid}-nit-${process.pid}`);
                    if (!h) throw new Error('sem repo');
                    cmd = new LocalRepoCommands(h.dir);
                }
                const diff = '';
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
