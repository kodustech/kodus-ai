#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821, precisao: tecnicas aplicadas so aos comentarios UNICOS que sobraram do
 * dedup de producao (grupo de um membro). Os grupos com consenso (2+ membros)
 * passam direto. Tudo no modelo do cenario; agentes com teto de 5 passos.
 *
 *   RECALL_MODEL=<id> node precisao-tecnicas.js --sufixo= --pool=<orig> --tecnica=base|defesa|correcao|torneio --out=arq.json
 *
 * base     o defeito ja existia no commit base? Se sim, sai (pre-existente).
 * defesa   um agente faz o papel do autor e defende o codigo; um juiz no mesmo
 *          modelo le acusacao e defesa e decide se o comentario vai.
 * correcao um agente escreve a correcao minima; outro, sem te-la escrito,
 *          avalia se ela muda comportamento e e concreta. Se nao, sai.
 * torneio  comparacao por pares dentro do PR ("qual o autor corrigiria
 *          primeiro?"); ranking por vitorias. O corte (top 2/3 unicos) e feito
 *          na medicao.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { prepareRepo } = require('./prepare-repo');
const { LocalRepoCommands } = require('./local-repo-commands');
const { extraiJson } = require('./eval-structured');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const SUFIXO = arg('sufixo'), POOL = arg('pool'), TECNICA = arg('tecnica'), OUT = arg('out');
const PAR = Number(arg('par', '3'));
const SO = (arg('only', '') || '').split(',').filter(Boolean);
const MODELO = process.env.RECALL_MODEL;
const TETO = 5;
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
if (!SUFIXO || !POOL || !TECNICA || !OUT || !MODELO) throw new Error('uso: RECALL_MODEL=... --sufixo= --pool= --tecnica= --out=');

function tools(cmd, baseCmd) {
    const t = {
        grep: tool({
            description: 'Search the repository (pull request head) for a regex pattern.',
            inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
            execute: async ({ pattern, path: p, glob }) => { try { return String(await cmd.grep(pattern, p, glob)).slice(0, 6000); } catch (e) { return `grep failed: ${String(e.message || e).slice(0, 120)}`; } },
        }),
        readFile: tool({
            description: 'Read a file at the pull request head, optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => { try { return String(await cmd.read(p, startLine, endLine)).slice(0, 12000); } catch (e) { return `readFile failed: ${String(e.message || e).slice(0, 120)}`; } },
        }),
    };
    if (baseCmd) {
        t.readBaseFile = tool({
            description: 'Read a file as it was BEFORE this pull request (the base commit), optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => baseCmd(p, startLine, endLine),
        });
    }
    return t;
}

async function agente(model, sys, prompt, ferramentas, submitSchema) {
    let enviado = null;
    const todas = { ...ferramentas, submit: tool({ description: 'Submit your answer. The only way to answer.', inputSchema: jsonSchema(submitSchema), execute: async (x) => { enviado = x; return 'recorded'; } }) };
    const r = await generateText({
        model, system: sys, prompt, tools: todas,
        stopWhen: (x) => !!enviado || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['submit'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submit' } }),
                messages: [...messages, { role: 'user', content: 'You are at the final step. Call submit now with what you have. Do not investigate further.' }] }
            : undefined,
    });
    if (!enviado) enviado = (r.toolCalls || []).find((c) => c.toolName === 'submit')?.input || extraiJson(r.text || '') || null;
    return { enviado, passos: r.steps?.length ?? 0 };
}

async function umTiro(model, sys, prompt) {
    const r = await generateText({ model, system: sys, prompt: `${prompt}\n\nReturn ONLY the JSON object. No prose, no code fence.` });
    return extraiJson(r.text || '');
}

const retry = async (fn) => { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; };
// Diff do PR no comeco do prompt dos juizes e do torneio: mesmo prefixo para
// todas as chamadas do PR, entao entra em cache.
const comDiff = (diff, texto) => `<PullRequestDiff>\n${diff}\n</PullRequestDiff>\n\n${texto}`;
const diffDe = (v) => {
    let arr = v?.changedFilesFull; if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
    return (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n').slice(0, 40000);
};
const bloco = (c) => `File: ${c.relevantFile}\nLines: ${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? c.relevantLinesStart ?? '?'}\nClaim: ${c.suggestionContent}`;

// ---------- tecnicas ----------
async function tecBase(model, c, cmd, baseCmd) {
    const sys = 'You decide whether a code review finding describes a defect INTRODUCED by this pull request, or one that already existed before it.';
    const p = `${bloco(c)}

Read the cited code at the pull request head (readFile) and the same code BEFORE the pull request (readBaseFile). Then answer: does the defect the claim describes already exist in the base version, with the same behavior, before this pull request?

- If the pull request did not change the code or the behavior that makes the claim true, the defect is PRE-EXISTING.
- If the pull request added, changed or removed code so that the claim is now true (or truer), it is INTRODUCED.
- If you cannot tell, answer introduced.

Call submit with {"introducedByPr": true|false, "evidence": "what you compared, citing base and head lines"}.`;
    const { enviado, passos } = await agente(model, sys, p, tools(cmd, baseCmd), { type: 'object', properties: { introducedByPr: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['introducedByPr', 'evidence'] });
    return { fica: enviado?.introducedByPr !== false, detalhe: enviado, passos };
}

async function tecDefesa(model, c, cmd, diff) {
    const sysAutor = 'You are the author of this pull request. A reviewer left the comment below on your code.';
    const p = `${bloco(c)}

Use the tools to build the strongest HONEST defense of your code: why it is correct, why the behavior is intentional, why the case is already handled somewhere else, or why the problem cannot happen or does not matter in practice. Cite the code you read.

If you investigate and find the reviewer is right, say so: do not invent a defense.

Call submit with {"concedes": true|false, "defense": "your defense, citing file:line, or why you concede"}.`;
    const a = await agente(model, sysAutor, p, tools(cmd), { type: 'object', properties: { concedes: { type: 'boolean' }, defense: { type: 'string' } }, required: ['concedes', 'defense'] });
    if (a.enviado?.concedes) return { fica: true, detalhe: { autor: a.enviado }, passos: a.passos };
    const juiz = await umTiro(model, 'You are a senior engineer deciding whether a code review comment should be posted on a pull request.', comDiff(diff, `REVIEW COMMENT (the accusation):
${bloco(c)}

THE AUTHOR'S DEFENSE:
${a.enviado?.defense || '(no defense given)'}

Decide: after reading both, should the comment be posted? Post it if the defense does not hold, misses the point, or only argues the problem is unlikely when it is a real defect. Do not post it if the defense shows the claim is wrong, the behavior is intentional and fine, or the issue cannot happen.

JSON: {"post": true|false, "reason": "one sentence"}`));
    return { fica: juiz?.post !== false, detalhe: { autor: a.enviado, juiz }, passos: a.passos };
}

async function tecCorrecao(model, c, cmd, diff) {
    const sys = 'You fix code review findings with the smallest possible change.';
    const p = `${bloco(c)}

Write the MINIMAL code change that fixes the defect this finding describes. Read the code first. Give the exact lines before and after. If there is no concrete change that would fix it (the finding is a general observation, or the code is already correct), say so.

Call submit with {"fixable": true|false, "before": "exact current lines", "after": "the fixed lines", "file": "path", "explanation": "one sentence"}.`;
    const a = await agente(model, sys, p, tools(cmd), { type: 'object', properties: { fixable: { type: 'boolean' }, before: { type: 'string' }, after: { type: 'string' }, file: { type: 'string' }, explanation: { type: 'string' } }, required: ['fixable', 'explanation'] });
    const f = a.enviado;
    if (!f || f.fixable === false) return { fica: false, detalhe: { correcao: f }, passos: a.passos };
    const av = await umTiro(model, 'You evaluate a proposed code fix written by someone else for a code review comment.', comDiff(diff, `REVIEW COMMENT:
${bloco(c)}

PROPOSED FIX (${f.file || c.relevantFile}):
--- before
${String(f.before || '').slice(0, 3000)}
--- after
${String(f.after || '').slice(0, 3000)}

Answer three questions about the FIX, not about the comment:
1. changesBehavior: would this change make the program behave differently at runtime (a different value, branch, error or side effect), as opposed to a rename, a comment, formatting, logging or a defensive check that never triggers?
2. concreteAndLocal: is it a specific, small change at the cited place, as opposed to a vague or sweeping rewrite?
3. verdict: "keep" if the fix is a concrete behavior change a developer would apply; otherwise "drop".

JSON: {"changesBehavior": true|false, "concreteAndLocal": true|false, "verdict": "keep"|"drop", "reason": "one sentence"}`));
    return { fica: av?.verdict !== 'drop', detalhe: { correcao: f, avaliacao: av }, passos: a.passos };
}

async function compara(model, a, b, diff) {
    const r = await umTiro(model, 'You compare two code review comments left on the same pull request.', comDiff(diff, `COMMENT A:
${bloco(a)}

COMMENT B:
${bloco(b)}

If you were the author of this pull request, which of the two would you fix FIRST, before merging? Pick the one that matters more to the code working correctly in production.

JSON: {"choice": "A"|"B"}`));
    return r?.choice === 'B' ? 'B' : r?.choice === 'A' ? 'A' : null;
}

(async () => {
    const model = buildModel(MODELO);
    console.log(`[tecnica ${TECNICA}] ${descreveModelo(MODELO)} · ${SUFIXO}`);
    const DD = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'dedup-prod2', `${SUFIXO}.json`), 'utf8')).prs;
    const vars = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try { const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars; if (v?.caseId) vars[v.caseId] = v; } catch {}
    }
    const L30 = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8'));
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { prs: {} };
    const fila = L30.filter((c) => (!SO.length || SO.includes(c)) && DD[c] && !DD[c].erro && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        const cands = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
        const membros = DD[cid].membros || {};
        const unicos = (DD[cid].kept || []).filter((k) => (membros[k] || [k]).length === 1);
        const diffPr = diffDe(vars[cid]);
        let h;
        try {
            const decis = {};
            if (TECNICA === 'torneio') {
                const vit = Object.fromEntries(unicos.map((k) => [k, 0]));
                const pares = [];
                for (let x = 0; x < unicos.length; x++) for (let y = x + 1; y < unicos.length; y++) pares.push([unicos[x], unicos[y]]);
                let j = 0;
                await Promise.all(Array.from({ length: 4 }, async () => {
                    while (j < pares.length) {
                        const n = j++; let [a, b] = pares[n];
                        if (n % 2) [a, b] = [b, a]; // alterna quem e A, contra o vies de posicao
                        const e = await retry(() => compara(model, cands[a], cands[b], diffPr));
                        if (e === 'A') vit[a]++; else if (e === 'B') vit[b]++;
                    }
                }));
                res.prs[cid] = { unicos, ranking: [...unicos].sort((p, q) => vit[q] - vit[p]), vitorias: vit, pares: pares.length };
            } else {
                h = await prepareRepo(vars[cid], `${cid}-tec-${process.pid}`);
                if (!h) throw new Error('sem repo');
                const cmd = new LocalRepoCommands(h.dir);
                const base = vars[cid].benchmarkBaseRef;
                const baseCmd = (p, s, e) => new Promise((ok) => execFile('git', ['-C', h.dir, 'show', `${base || 'HEAD~1'}:${String(p).replace(/^\.?\/+/, '')}`], { maxBuffer: 50 * 1024 * 1024 }, (err, out) => {
                    if (err) {
                        const m = String(err.message || '');
                        // Arquivo criado pelo PR: nao existe no base, e isso e a resposta.
                        if (/does not exist in|exists on disk, but not in|path .* does not exist/i.test(m)) return ok('This file did not exist before this pull request: it was added by it.');
                        return ok(`readBaseFile failed: ${m.slice(0, 120)}`);
                    }
                    const linhas = String(out).split('\n'); const a = s > 0 ? s - 1 : 0; const b = e > 0 ? e : linhas.length;
                    ok(linhas.slice(a, b).map((l, k) => `${a + k + 1}: ${l}`).join('\n').slice(0, 12000));
                }));
                let j = 0;
                await Promise.all(Array.from({ length: 4 }, async () => {
                    while (j < unicos.length) {
                        const k = unicos[j++];
                        const fn = TECNICA === 'base' ? () => tecBase(model, cands[k], cmd, baseCmd)
                            : TECNICA === 'defesa' ? () => tecDefesa(model, cands[k], cmd, diffPr)
                            : () => tecCorrecao(model, cands[k], cmd, diffPr);
                        try { decis[k] = await retry(fn); } catch (e) { decis[k] = { fica: true, erro: String(e?.message || e).slice(0, 200) }; }
                    }
                }));
                res.prs[cid] = { unicos, decisoes: decis };
            }
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const unic = ok.reduce((a, p) => a + p.unicos.length, 0);
    const saem = ok.reduce((a, p) => a + Object.values(p.decisoes || {}).filter((d) => !d.fica).length, 0);
    console.log(JSON.stringify({ sufixo: SUFIXO, tecnica: TECNICA, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, unicos: unic, saem }));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
