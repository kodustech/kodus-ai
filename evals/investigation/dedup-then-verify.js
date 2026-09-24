#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { registerTracing, tele, comTrace, flush } = require('./eval-tracing');
/**
 * Splits the reducer back into its two jobs and puts the tools where they help.
 *
 * The single reducer answers "which of these are the same?" and "which of these
 * are true?" in one pass over the whole set. The first question needs the set;
 * the second needs the code. Measured: the reducer with tools raised precision
 * by ~2pp — it has thirty steps for a dozen claims, so it verifies the first
 * few and rates the rest on plausibility, which is what it did before.
 *
 * Here: DEDUP over the set (no tools, one call), then VERIFY each survivor on
 * its own with grep/readFile and a budget that is not shared with anyone else.
 *
 * The obvious objection is that per-item verification is what `verify` already
 * was, and verify kept 84 of 85. The difference is the tools: verify could only
 * ask how plausible a claim sounded, and a claim in isolation has nothing to be
 * implausible against. With the repo in hand the question becomes closed —
 * does this caller check for null or not.
 *
 * Refutation is the only reason to drop. An unverified claim is kept, because
 * the recall floor matters more than the precision gain.
 *
 * Usage:
 *   node evals/investigation/dedup-then-verify.js [--limit=10] [--maxsteps=8]
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { runDedup } = require('../dedup/dedup-runner');
const { buildModel, descreveModelo } = require('./eval-model');
const { loadJudgeKey, matchCommentDetailed } = require('./recall-judge');
const { prepareRepo } = require('./prepare-repo');
const {
    buildFeasibilityVerifierPrompt,
} = require('@libs/code-review/infrastructure/agents/prompts/verifier-prompt');
const { LocalRepoCommands } = require('./local-repo-commands');

// Onde ficam os dumps. Ja foi um caminho absoluto de scratchpad cravado aqui,
// o que fazia o script falhar em silencio fora daquela sessao.
const S = process.env.POOL_ROOT || require('path').join(__dirname, 'pools');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const LIMIT = Number(arg('limit', '10'));
const MAXSTEPS = Number(arg('maxsteps', '8'));
const DUMPS = arg('dumps', 'm14,m14r,m14r8,quota1,simP').split(',');
const OUT = arg('out', path.join(__dirname, 'results', 'dedup-then-verify.json'));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol';
registerTracing('dedup-verify');
/** O dedup nao depende do criterio de verificacao e nao muda entre rodadas:
 *  re-executa-lo a cada experimento paga a mesma chamada de novo para o mesmo
 *  resultado. A chave inclui o conjunto de candidatos, entao um dump novo
 *  invalida a entrada sozinho. */
const CACHE = path.join(__dirname, 'results', 'dedup-cache.json');
const cache = (() => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } })();
const chaveDe = (cid, cands) =>
    `${cid}|${cands.length}|${require('crypto').createHash('sha1')
        .update(cands.map((c) => `${c.relevantFile}:${c.relevantLinesStart}:${String(c.oneSentenceSummary).slice(0, 60)}`).join('|'))
        .digest('hex').slice(0, 12)}`;
/** `feasibility` = o prompt que ja existe em producao (onus invertido, descarta
 *  o nao-provado). `threeway` = o desta investigacao (mantem o nao-provado).
 *  Mesma ordem, mesma entrada, mesmas tools: a unica variavel e quem carrega o
 *  onus da prova. */
const CRIT = arg('criterio', 'feasibility');
/** Só estes casos (retomar sem refazer o que já mediu). */
const SO = (arg('only', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
/** Verificações simultâneas. Cada candidato é uma pergunta independente sobre
 *  um trecho diferente — serializá-las custou 9 minutos por PR sem nenhum
 *  ganho. 5 é o que o provedor aguenta sem devolver "overloaded". */
const PAR = Number(arg('par', '5'));
/** PRs simultâneos. Cada um prepara o próprio worktree e não toca no dos
 *  outros, então o único acoplamento é a cota do provedor. */
const PARPR = Number(arg('parpr', '1'));
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);

function readTools(cmd) {
    return {
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
            execute: async ({ pattern, path: p }) => {
                try { return String(await cmd.grep(pattern, p)).slice(0, 6000); } catch (e) { return `grep failed: ${String(e.message).slice(0, 100)}`; }
            },
        }),
        readFile: tool({
            description: 'Read a file, optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => {
                try { return String(await cmd.read(p, startLine, endLine)).slice(0, 12000); } catch (e) { return `readFile failed: ${String(e.message).slice(0, 100)}`; }
            },
        }),
        verdict: tool({
            description: 'Record the verdict. You MUST call this exactly once, at the end.',
            inputSchema: jsonSchema({
                type: 'object',
                properties: {
                    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unverified'] },
                    evidence: { type: 'string', description: 'The file and lines you read that decided it.' },
                },
                required: ['verdict', 'evidence'],
                additionalProperties: false,
            }),
            execute: async () => ({ output: 'recorded' }),
        }),
    };
}

/**
 * Critério `pfa` — path-feasibility na forma que o LLM4PFA descreve
 * (arXiv 2506.10322), menos o solver.
 *
 * O paper tem três estágios: extrair as condições de branch que governam
 * alcançar o sink e raciocinar sobre o RANGE de cada variável; buscar o corpo
 * das funções que aparecem nessas condições para determinar o range de
 * retorno, descendo e guardando o que já analisou; e converter tudo para SMT,
 * onde UNSAT decide que o achado é falso positivo. Reporta 72-96% de falso
 * positivo filtrado com 0,93 de recall.
 *
 * O `buildFeasibilityVerifierPrompt` que já existe aqui pega só o espírito dos
 * dois primeiros — pede para traçar o caminho e olhar guards, e decide por
 * julgamento. A diferença que este critério tenta capturar é estrutural: a
 * decisão deixa de ser "isso parece alcançável?" e vira "existe atribuição que
 * satisfaça estas condições que você acabou de listar?". A segunda pergunta é
 * quase mecânica; a primeira é opinião.
 *
 * O Z3 continua de fora, então quem resolve as constraints é o próprio modelo.
 * O ganho que resta é que ele resolve sobre uma lista explícita em vez de
 * sobre uma impressão — e a lista fica no output, então dá para auditar.
 */
const pfaPrompt = (c) => `A reviewer claims the defect below exists in this pull request. Decide whether the failure it describes is REACHABLE, by extracting the conditions that govern it and then checking whether they can all hold at once.

<Claim>
  file: ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
  ${c.oneSentenceSummary || ''}
  ${String(c.suggestionContent || '').slice(0, 900)}${c.existingCode ? `\n  code: ${String(c.existingCode).slice(0, 250)}` : ''}${c.reason ? `\n  walk the reviewer recorded: ${String(c.reason).slice(0, 700)}` : ''}
</Claim>

Work in three steps, in order, with grep and readFile. Do not skip to the answer.

STEP 1 — PATH CONSTRAINTS.
List every branch condition that must hold for execution to reach the flagged
line with the bad state the claim needs. One per line, each with file:line.
Include the conditions in the flagged function and in every caller you had to
pass through. If a guard, early return or validation sits on that path, it
belongs in this list as a condition that must be FALSE for the bug to happen.

STEP 2 — RANGES.
For every variable appearing in those conditions, state the values it can
actually take, read from the code and not assumed. When a value comes from a
function call, read that function and give its return range; if that depends on
another call, follow it, up to five levels. Write "unknown" when you could not
establish it — never invent a range.

STEP 3 — SATISFIABILITY.
Ask whether there is an assignment of those variables that satisfies EVERY
condition in step 1 at once AND produces the bad state the claim describes.
  - No such assignment can exist -> the path is infeasible.
  - One exists -> name it concretely: this variable takes this value.
  - You could not establish enough ranges to tell -> unknown.

Then call verdict exactly once:
  refuted    -> step 3 found the path infeasible, or a condition in step 1 is a
                guard that always blocks it. Use this too when the claim only
                asks for a defence (a bound, a limit, a validation) and step 1
                found no path that reaches a failure without it.
  confirmed  -> step 3 produced a concrete satisfying assignment.
  unverified -> step 3 came out unknown.

Put the constraint list and the ranges in the "evidence" field, not just the conclusion —
a verdict whose constraints are not written down cannot be checked by anyone.

"unverified" is a real answer and costs nothing. A wrong "refuted" deletes a
real defect.`;

/**
 * Criterio `walk` — refutar o percurso, nao redescobrir o bug.
 *
 * Os outros tres criterios pedem ao verificador que chegue sozinho a uma
 * conclusao sobre o achado: ele le o codigo e decide se acredita. Isso e caro e
 * e a mesma tarefa que o gerador ja fez — com a diferenca de que o verificador
 * tem menos contexto, entao ele erra mais, e "refuted" acaba matando achado bom.
 *
 * Com `RECALL_FINDING_REASON` ligado, cada achado chega com o percurso que o
 * produziu. Isso muda a tarefa: em vez de opinar sobre a conclusao, da para
 * quebrar o percurso em afirmacoes e conferir uma por uma. Uma afirmacao sobre
 * o codigo ("esta funcao pode devolver null", "nao existe guard aqui") ou bate
 * com o arquivo ou nao bate, e quando nao bate o achado cai por um motivo que
 * fica escrito — nao por um juizo.
 *
 * Dai a regra de descarte ser conjuntiva: o achado morre se QUALQUER passo for
 * falso, e sobrevive se todos forem verdadeiros ou indeterminados. E o que
 * torna isto diferente de mais um verificador com outro prompt.
 */
const walkPrompt = (c) => `A reviewer flagged the code below and recorded the walk that led them there. Your job is not to decide whether the defect is worth reporting — it is to check whether that walk survives contact with the code.

<Claim>
  file: ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
  ${c.oneSentenceSummary || ''}
  ${String(c.suggestionContent || '').slice(0, 900)}${c.existingCode ? `\n  code at those lines:\n${String(c.existingCode || '').slice(0, 600)}` : ''}
</Claim>

<Walk>
${String(c.reason || '(the reviewer recorded no walk)').slice(0, 1200)}
</Walk>

STEP 1 — SPLIT THE WALK.
Rewrite the walk as a numbered list of claims ABOUT THE CODE, each one something
a file can agree or disagree with. Keep the reviewer's own steps; do not improve
them, do not add steps they did not take, do not repair a gap by filling it in.
Typical shapes: "function F can return null", "no caller checks X", "this loop
runs with i equal to len", "the value written at line N is read at line M".
Drop anything that is opinion rather than a claim about code.

STEP 2 — CHECK EACH ONE.
For every numbered claim, go to the code with grep and readFile at the exact
place the claim is about, and mark it:
  TRUE    — you read the lines and they say what the claim says. Give file:line.
  FALSE   — you read the lines and they contradict it. Give file:line and quote
            the part that contradicts it.
  UNKNOWN — you could not reach the code that settles it. Say what you needed.
Check the claim as written. A claim that is true in a narrower case than the
reviewer stated is FALSE, and say which case survives.

STEP 3 — THE START AND THE END.
Two specific checks the split tends to miss:
  (a) does the walk actually start at code this pull request changed, or does it
      start somewhere the change never touches?
  (b) does the last step end in something going wrong — a wrong value, a crash,
      data lost, a permission not enforced — or does it end at "this is not how
      I would write it"? A walk that ends without a failure has no bug at its end.

STEP 4 — IS THE FALSE STEP LOAD-BEARING?
Only if step 2 produced a FALSE. A walk can be wrong about the route and still
be right that something breaks. So for each FALSE claim, ask: with that claim
corrected to what the code actually says, does the failure at the end of the
walk still happen — by the route the walk took, or by an obvious neighbouring
one you can point at in the code?
  - The failure is gone: the false step was load-bearing.
  - The failure still stands, the walk just described the route badly: the false
    step was not load-bearing. Say which route survives, with file:line.
A walk that overstates the symptom (says "crash" where the code gives a wrong
value, or names the wrong exception) but lands on something that is still wrong
is NOT load-bearing-false. Judge the defect, not the prose.

Then call verdict exactly once, by this rule and no other:
  refuted    — a FALSE claim in step 2 was load-bearing by step 4, or step 3
               found the walk starts outside the change or ends with no failure.
  confirmed  — every claim came out TRUE and step 3 passed both checks.
  unverified — nothing false was load-bearing but at least one claim is UNKNOWN,
               or a FALSE claim was not load-bearing and you could not settle
               the surviving route. Someone else decides those.

Put the numbered list with its TRUE/FALSE/UNKNOWN and the file:line for each
into "evidence". A verdict whose list is not written down cannot be checked.

Do not refute because the walk is thin, or because you would have argued it
differently, or because the defect looks minor. Refute only on a false step that
step 4 showed carries the failure — everything else is someone else's call.`;

const verifyPrompt = (c) => `A reviewer made the claim below about this pull request. Decide whether it is TRUE of this code.

<Claim>
  file: ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
  ${c.oneSentenceSummary || ''}
  ${String(c.suggestionContent || '').slice(0, 900)}${c.existingCode ? `\n  code: ${String(c.existingCode).slice(0, 250)}` : ''}${c.reason ? `\n  walk the reviewer recorded: ${String(c.reason).slice(0, 700)}` : ''}
</Claim>

Turn the claim into a question the code answers, then answer it with grep and
readFile. Read the caller if it says a caller breaks; read what produces the
value if it says the value can be null; grep for the guard if it says a guard is
missing; grep for the symbol before believing it is absent.

Then call verdict exactly once:
  refuted    — you read the code and it contradicts the claim. Also use this for
               a claim that only asks for a defence (a bound, a limit, a
               validation, a rate limit) with no caller that actually violates
               it, and for a problem that was already there before this change.
  confirmed  — you read the code and it holds.
  unverified — you could not settle it within your budget.

Do not guess. "unverified" is a real answer and costs nothing; a wrong "refuted"
deletes a real defect.`;

(async () => {
    const pool = {}, vars = {}, goldens = {};
    for (const d of DUMPS) {
        const dir = path.join(S, d);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.raw.txt'))) {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const c = j.trace?.preFilterCandidates || [];
            if (c.length) (pool[j.caseId] ||= []).push(...c);
        }
    }
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (v?.caseId) { goldens[v.caseId] = J(v.goldenComments); vars[v.caseId] = v; }
        } catch {}
    }

    const model = buildModel(MODEL);
    console.log(`[modelo] ${descreveModelo(MODEL)}`);
    const key = loadJudgeKey();
    const ids = Object.keys(pool)
        .filter((c) => goldens[c]?.length)
        .filter((c) => !SO.length || SO.includes(c))
        .slice(0, LIMIT);
    let TP = 0, FP = 0, GOLD = 0, DEDUPED = 0, REF = 0, CONF = 0, UNV = 0;
    // "unverified" tem duas origens que o numero final confunde: o modelo
    // dizendo que nao conseguiu decidir, e a gente nao conseguindo ler a
    // resposta dele. A segunda e bug, a primeira e resultado.
    const diag = { semRepo: 0, semTool: 0, semParse: 0, erro: 0, toolCalls: 0, toolErros: 0, passos: 0, segundaChance: 0, motivos: [] };
    const out = [];

    const rodarPR = async (cid, i) => {
        const cands = pool[cid];
        // 1) DEDUP — set operation, no tools.
        let uniq = cands;
        const ck = chaveDe(cid, cands);
        if (cache[ck]) {
            uniq = cache[ck].map((k) => cands[k]).filter(Boolean);
        } else {
            try {
                const d = await runDedup(cands, undefined, { model });
                const idx = d.kept || cands.map((_, k) => k);
                uniq = idx.map((k) => cands[k]).filter(Boolean);
                cache[ck] = idx;
                fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
            } catch (e) {
                    diag.motivos.push(`dedup: ${String(e?.message || e).slice(0, 160)}`);
                    console.log(`   dedup falhou: ${String(e.message).slice(0, 80)}`);
                }
        }
        DEDUPED += cands.length - uniq.length;

        // 2) VERIFY — per candidate, with the repo.
        let rt;
        // `prepareRepo` cria um worktree por caso e devolve `cleanup`. Nenhum
        // destes scripts chamava, e 34 worktrees de grafana/keycloak/sentry
        // encheram o disco — a partir dali `worktree add` falhava com "No space
        // left on device", prepareRepo devolvia null em silencio, e 48 de 170
        // candidatos rodaram SEM ferramenta nenhuma, contados como "nao
        // verificado". O resultado media quanto do experimento conseguiu rodar.
        let handle = null;
        try {
            handle = await prepareRepo(vars[cid], cid);
            if (handle) rt = readTools(new LocalRepoCommands(handle.dir));
            else diag.motivos.push(`prepareRepo devolveu null para ${cid}`);
        } catch (e) {
            diag.motivos.push(`prepareRepo: ${String(e?.message || e).slice(0, 120)}`);
        }
        const verificar = async (c) => {
            if (!rt) { diag.semRepo++; return { c, v: 'unverified' }; }
            let v = 'unverified';
            // O "por que" do descarte e o produto do criterio `walk`, nao um
            // detalhe de log: sem ele nao da para saber se o filtro matou bug
            // bom, que e a unica pergunta que importa sobre um filtro.
            let ev = '';
            try {
                if (CRIT === 'feasibility') {
                    const bundle = `CANDIDATE FINDING [0]\n  file: ${c.relevantFile}:${c.relevantLinesStart ?? '?'}\n  ${c.oneSentenceSummary || ''}\n  ${String(c.suggestionContent || '').slice(0, 900)}\n  existingCode:\n${String(c.existingCode || '').slice(0, 600)}`;
                    const { system, prompt } = buildFeasibilityVerifierPrompt(bundle, 0);
                    const r = await generateText({
                        ...tele('dedup-verify'),
                        model, tools: { grep: rt.grep, readFile: rt.readFile },
                        system, prompt,
                        stopWhen: (x) => (x.steps?.length ?? 0) >= MAXSTEPS,
                    });
                    // Ele responde JSON em prosa, nao por tool — o verdict tool
                    // fica de fora para nao mudar o prompt que esta em producao.
                    diag.passos += (r.steps || []).length;
                    for (const st of r.steps || []) {
                        diag.toolCalls += (st.toolCalls || []).length;
                        for (const tr of st.toolResults || []) if (/failed:/.test(String(tr.output ?? tr.result ?? ''))) diag.toolErros++;
                    }
                    const m = String(r.text || '').match(/"keep"\s*:\s*(true|false)/);
                    if (!m) diag.semParse++;
                    v = m ? (m[1] === 'true' ? 'confirmed' : 'refuted') : 'unverified';
                } else {
                    // Um turno que acaba sem chamar `verdict` cai em
                    // "unverified" e o candidato fica — indistinguivel de o
                    // modelo ter dito que nao soube. Medido: 1 em 7 terminava
                    // assim. Duas defesas: um passo a mais para ele fechar
                    // depois de investigar, e o pedido explicito de chamar a
                    // tool quando o orcamento acabar.
                    const r = await generateText({
                        ...tele('dedup-verify'),
                        model, tools: rt,
                        prompt:
                            (CRIT === 'pfa' ? pfaPrompt(c) : CRIT === 'walk' ? walkPrompt(c) : verifyPrompt(c)) +
                            '\n\nYou must end by calling verdict. If you run out of budget before settling it, call verdict with "unverified" and say in evidence what you still needed to read — ending without the call loses your work.',
                        stopWhen: (x) =>
                            (x.steps?.length ?? 0) >= MAXSTEPS ||
                            (x.steps || []).some((st) =>
                                (st.toolCalls || []).some((t) => (t.toolName ?? t.name) === 'verdict'),
                            ),
                    });
                    // Ultimo recurso: se mesmo assim nao chamou, pergunta de
                    // novo com a tool forcada.
                    //
                    // O HISTORICO PRECISA IR JUNTO. Antes isto era um
                    // `generateText` com `prompt`, ou seja, uma conversa nova:
                    // pedia "registre o veredito a partir do que voce ja sabe"
                    // a um modelo que nao sabia nada, porque as leituras tinham
                    // ficado no turno anterior. Fechava sempre em "unverified",
                    // que no pipeline quer dizer MANTER — o deepseek quase
                    // nunca chama a tool sozinho, entao 10 de 12 candidatos
                    // sobreviviam por um veredito inventado do nada.
                    let call0 = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'verdict');
                    if (!call0) {
                        diag.segundaChance++;
                        try {
                            const r2 = await generateText({
                                ...tele('dedup-verify-forcado'),
                                model,
                                tools: { verdict: rt.verdict },
                                toolChoice: { type: 'tool', toolName: 'verdict' },
                                messages: [
                                    ...(r.response?.messages || []),
                                    {
                                        role: 'user',
                                        content:
                                            'Record your verdict now, from the reading you just did above. Use "unverified" only if that reading genuinely did not settle it — not because you would rather not decide.',
                                    },
                                ],
                            });
                            r.toolCalls = [...(r.toolCalls || []), ...(r2.toolCalls || [])];
                        } catch (e2) {
                            diag.erro++;
                            diag.motivos.push(`segunda-chance: ${String(e2?.message || e2).slice(0, 160)}`);
                        }
                    }
                    diag.passos += (r.steps || []).length;
                    for (const st of r.steps || []) {
                        diag.toolCalls += (st.toolCalls || []).length;
                        for (const tr of st.toolResults || []) if (/failed:/.test(String(tr.output ?? tr.result ?? ''))) diag.toolErros++;
                    }
                    const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'verdict');
                    if (!call) diag.semTool++;
                    v = (call?.input ?? call?.args)?.verdict || 'unverified';
                    ev = String((call?.input ?? call?.args)?.evidence || '');
                }
            } catch (e) {
                diag.erro++;
                diag.motivos.push(`verify: ${String(e?.message || e).slice(0, 160)}`);
            }
            return { c, v, ev };
        };
        // Em lotes: independentes entre si, mas disparar 20 de uma vez faz o
        // provedor devolver "overloaded" e o resultado some.
        const kept = [];
        const descartados = [];
        for (let b = 0; b < uniq.length; b += PAR) {
            const lote = await Promise.all(uniq.slice(b, b + PAR).map(verificar));
            for (const { c, v, ev } of lote) {
                if (v === 'refuted') {
                    REF++;
                    descartados.push({
                        relevantFile: c.relevantFile,
                        relevantLinesStart: c.relevantLinesStart,
                        relevantLinesEnd: c.relevantLinesEnd,
                        oneSentenceSummary: c.oneSentenceSummary,
                        suggestionContent: c.suggestionContent,
                        existingCode: c.existingCode,
                        reason: c.reason,
                        producedBy: c.producedBy,
                        evidencia: String(ev).slice(0, 2500),
                    });
                    continue;
                }
                v === 'confirmed' ? CONF++ : UNV++;
                kept.push(c);
            }
        }

        const hit = new Set();
        for (const g of goldens[cid]) {
            for (const s of kept) {
                const txt = [s.oneSentenceSummary, s.suggestionContent].filter(Boolean).join('\n').slice(0, 1800);
                try { const v = await matchCommentDetailed(key, g.comment, txt); if (v?.match && (v.confidence ?? 0) >= 0.5) { hit.add(g.comment); break; } } catch {}
            }
        }
        TP += hit.size; FP += Math.max(kept.length - hit.size, 0); GOLD += goldens[cid].length;
        try { await handle?.cleanup?.(); } catch {}
        out.push({ caseId: cid, cands: cands.length, uniq: uniq.length, kept: kept.length, tp: hit.size, goldens: goldens[cid].length, descartados });
        console.log(`[${i + 1}/${ids.length}] ${cid.slice(0, 42).padEnd(44)} ${cands.length}→dedup ${uniq.length}→verify ${kept.length} · tp ${hit.size}/${goldens[cid].length}`);
    };
    for (let b = 0; b < ids.length; b += PARPR) {
        await Promise.all(
            ids.slice(b, b + PARPR).map((cid, k) =>
                comTrace(
                    {
                        traceName: `dedup-verify`,
                        sessionId: cid,
                        metadata: { caseId: cid, criterio: typeof CRIT !== 'undefined' ? CRIT : 'painel' },
                        tags: ['investigation', `dedup-verify`],
                    },
                    () => rodarPR(cid, b + k),
                ),
            ),
        );
    }
    const rec = TP / GOLD, pre = TP / Math.max(TP + FP, 1);
    fs.writeFileSync(OUT, JSON.stringify({ TP, FP, GOLD, recall: rec, precision: pre, dedupRemoveu: DEDUPED, confirmados: CONF, refutados: REF, naoVerificados: UNV, diagnostico: diag, porPR: out }, null, 2));
    console.log(`\nDIAGNOSTICO DE EXECUCAO`);
    console.log(`  sem repo: ${diag.semRepo} · tool verdict nao chamada: ${diag.semTool} · segunda chance usada: ${diag.segundaChance} · JSON nao parseado: ${diag.semParse} · erro: ${diag.erro}`);
    console.log(`  passos somados: ${diag.passos} · tool calls: ${diag.toolCalls} · retornaram erro: ${diag.toolErros}`);
    if (diag.motivos.length) {
        console.log(`  MOTIVOS DOS ERROS (${diag.motivos.length}):`);
        const c = {};
        for (const m of diag.motivos) c[m] = (c[m] || 0) + 1;
        for (const [m, n] of Object.entries(c).sort((a, b) => b[1] - a[1])) console.log(`    ${n}x  ${m}`);
    }
    console.log(`\nDEDUP -> VERIFY (${CRIT}, um a um, com tools)`);
    console.log(`  dedup removeu ${DEDUPED} · verify: ${CONF} confirmados, ${REF} refutados, ${UNV} nao verificados`);
    console.log(`  tp=${TP} fp=${FP} de ${GOLD} goldens`);
    console.log(`  recall=${rec.toFixed(3)}  precision=${pre.toFixed(3)}`);
    await flush();
    console.log(`\n-> ${OUT}`);
})();
