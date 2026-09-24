#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { registerTracing, tele, comTrace, flush } = require('./eval-tracing');
/**
 * Painel adversarial por ARQUIVO: defensor, refutador, juiz.
 *
 * Por que adversarial e nao tematico. Um painel de especialistas por assunto
 * (seguranca, performance, QA) ja existe no harness e a medicao nao mudou nada:
 * generalista e shard acham 74% das MESMAS coisas, e nos quatro PRs grandes
 * doze configuracoes distintas deram sempre o mesmo resultado. Voz a mais
 * converge. E o nosso problema nao e falta de especialidade — os falsos
 * positivos nao estao errados por terem sido olhados pela lente errada, estao
 * errados porque ninguem conferiu o codigo. Um especialista em seguranca
 * afirmando "falta rate limit" produz exatamente o mesmo falso positivo.
 *
 * O que um debate acrescenta e um redutor sozinho nao tem e um adversario
 * OBRIGADO A PRODUZIR EVIDENCIA. Dai os papeis serem acusacao e defesa, e o
 * juiz decidir so pelo que foi citado com file:line.
 *
 * Por arquivo, e nao por candidato: 327 candidatos vivem em 128 arquivos
 * (2,6 por arquivo, 43% com um so). Agrupar corta 61% das analises, o painel
 * le o arquivo uma vez para todos os achados dele — que e o estagio 2 do
 * LLM4PFA, memoria para nao reanalisar — e poe candidatos do mesmo arquivo
 * lado a lado, onde dois que se contradizem ficam visiveis.
 *
 * Duas escolhas deliberadas:
 *  - o refutador pode dizer que nao achou nada contra. Obriga-lo a atacar faz
 *    dele advogado do diabo e entrega ruido ao juiz.
 *  - o juiz NAO ve severidade nem confianca do achado original: medido, elas
 *    nao discriminam (39 dos 118 falsos positivos vieram marcados High), e
 *    mostra-las so ancora a decisao.
 *  - empate sem evidencia de nenhum lado = KEEP, pelo piso de recall.
 *
 * Usage:
 *   node evals/investigation/panel-by-file.js [--limit=10] [--par=4]
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { loadJudgeKey, matchCommentDetailed } = require('./recall-judge');
const { prepareRepo } = require('./prepare-repo');
const { runDedup } = require('../dedup/dedup-runner');
const { LocalRepoCommands } = require('./local-repo-commands');

// Onde ficam os dumps. Ja foi um caminho absoluto de scratchpad cravado aqui,
// o que fazia o script falhar em silencio fora daquela sessao.
const S = process.env.POOL_ROOT || require('path').join(__dirname, 'pools');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const LIMIT = Number(arg('limit', '10'));
const PAR = Number(arg('par', '4'));
/** PRs simultâneos. Cada um prepara o próprio worktree; o único acoplamento
 *  é a cota do provedor. PAR × PARPR × 3 turnos é o que chega nele de uma vez
 *  — passar de ~20 devolve "overloaded" e o PR some do resultado. */
const PARPR = Number(arg('parpr', '3'));
const MAXSTEPS = Number(arg('maxsteps', '8'));
const DUMPS = arg('dumps', 'm14,m14r,m14r8,quota1,simP').split(',');
const OUT = arg('out', path.join(__dirname, 'results', 'panel-by-file.json'));
const SO = (arg('only', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
/** Dedup antes do painel. A primeira versão não tinha: o painel via os
 *  candidatos brutos, então duas cópias do mesmo achado entravam como dois
 *  falsos positivos e a precision saía deprimida por contagem, não por
 *  julgamento. Mesmo cache do dedup-then-verify — a chave é o conjunto de
 *  candidatos, então as duas ferramentas compartilham o resultado. */
const SEMDEDUP = process.argv.includes('--sem-dedup');
const CACHE = path.join(__dirname, 'results', 'dedup-cache.json');
const cache = (() => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } })();
const chaveDe = (cid, cands) =>
    `${cid}|${cands.length}|${require('crypto').createHash('sha1')
        .update(cands.map((c) => `${c.relevantFile}:${c.relevantLinesStart}:${String(c.oneSentenceSummary).slice(0, 60)}`).join('|'))
        .digest('hex').slice(0, 12)}`;
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol';
registerTracing('panel-by-file');
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);

function tools(cmd) {
    return {
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
            execute: async ({ pattern, path: p }) => {
                try { return String(await cmd.grep(pattern, p)).slice(0, 6000); } catch (e) { return `grep failed: ${String(e.message).slice(0, 90)}`; }
            },
        }),
        readFile: tool({
            description: 'Read a file, optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => {
                try { return String(await cmd.read(p, startLine, endLine)).slice(0, 12000); } catch (e) { return `readFile failed: ${String(e.message).slice(0, 90)}`; }
            },
        }),
    };
}

/** Severity and confidence are stripped here, not just hidden from the judge:
 *  the defender and the refuter would quote them back at it. */
const listar = (cands) =>
    cands
        .map(
            (c, i) =>
                `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}\n    ${c.oneSentenceSummary || ''}\n    ${String(c.suggestionContent || '').slice(0, 500)}${c.existingCode ? `\n    code: ${String(c.existingCode).slice(0, 250)}` : ''}${c.reason ? `\n    walk: ${String(c.reason).slice(0, 700)}` : ''}`,
        )
        .join('\n\n');

const pDefensor = (file, diff, cands) => `You are arguing FOR the findings below. They were raised on one file of a pull request, and someone will argue against them next.

<File>${file}</File>

<Diff>
${diff}
</Diff>

<Findings>
${listar(cands)}
</Findings>

For each finding, make the strongest case you honestly can, and make it out of
code you actually read with grep and readFile — not out of reasoning about what
the code probably does.

Answer by calling the "defesas" tool exactly once, with one entry per finding
index. Nothing else you write is read, so leave nothing for the prose.

  posicao "defendido"  -> "caminho" names the entry point and each call in
                          between, with file:line; "evidencia" lists the
                          file:line you actually read.
  posicao "concedido"  -> you read the code and the finding does not survive.
                          Put what killed it in "evidencia".

Conceding is worth more than defending: you are not scored on how many you
save, and a defence with no file:line behind it will be ignored downstream.`;

const pRefutador = (file, diff, cands, defesa) => `You are arguing AGAINST the findings below, on one file of a pull request. The defence has already been written and is included.

<File>${file}</File>

<Diff>
${diff}
</Diff>

<Findings>
${listar(cands)}
</Findings>

<Defence>
${defesa}
</Defence>

You are not being asked for an opinion on these findings. You are being asked
to CHECK FOUR FACTS about each one, and to report what you found. Answer by
calling the "checagens" tool exactly once, one entry per finding index.

  temGuard — is there a guard, validation, type constraint or early return on
    the path that makes the bad state impossible? If yes, put its file:line in
    "guardOnde".

  jaExistia — was this condition already true BEFORE this diff? Read the diff:
    if the flagged lines are context rather than additions, or the same pattern
    is present elsewhere untouched, the change did not introduce it. Say why in
    "jaExistiaPorque".

  pedeDefesaSemChamador — answer this one in two parts, in order, and do not
    collapse them:
      (a) does the finding's proposed fix ADD a check that is not there today —
          a bound, a limit, a rate limit, a length or range validation, a
          null guard?
      (b) if (a) is yes: grep the callers of this function and name ONE that
          actually passes a value the new check would reject. A hypothetical
          caller does not count; you must point at code.
    Answer "sim" when (a) is yes and (b) found nothing — that is a hardening
    suggestion, not a defect this change introduced. Answer "nao" when (a) is
    no, or when (b) found a real caller; put that caller's file:line in
    "guardOnde".

  simboloConfereComDescrito — do the symbols, types and behaviour it cites
    actually exist as described? Grep them. Put where you looked in
    "simboloOnde".

Answer "nao_verifiquei" when you did not check — it is a real answer and costs
nothing. Guessing is worse than not knowing.

"conclusao" follows from the four: "refutado" when a guard exists, or the
condition already existed, or it only asks for an unmotivated defence, or the
symbol does not match. Otherwise "nao_refutado". Do not invent an objection to
have one.`;

const pJuiz = (file, cands, defesa, ataque) => `You are deciding which of the findings below get posted on this pull request. Two reviewers argued, one for and one against, and their arguments are included.

<File>${file}</File>

<Findings>
${listar(cands)}
</Findings>

<Defence>
${defesa}
</Defence>

<Checks>
${ataque}
</Checks>

Decide each finding on the EVIDENCE CITED, not on how the arguments are
written. An assertion with no file:line behind it carries no weight, whichever
side made it. You may read the code yourself to settle a disagreement.

  drop  — a check came back "refutado" WITH a file:line behind it, or the
          defence conceded the finding itself.
  keep  — the defence cites a concrete path, or every check came back
          "nao_refutado" or "nao_verifiquei". An unrefuted finding stays: not
          knowing is not the same as knowing it is wrong.

Call verdicts exactly once with one entry per finding index.`;


/**
 * Saída estruturada obrigatória nas três fases, por tool call.
 *
 * Duas razões, e a primeira é um bug medido: em 3 de 5 painéis o defensor
 * gastou os passos em tool calls e terminou sem texto nenhum, então o
 * refutador e o juiz receberam uma defesa em branco sem que nada acusasse.
 * Uma tool obrigatória não deixa o turno terminar sem produzir.
 *
 * A segunda é portabilidade: isto vai rodar em outros modelos, e prosa livre
 * significa um parser por modelo. O schema é o contrato — o mesmo campo sai
 * igual em qualquer um, e dá para comparar execuções depois sem reprocessar
 * texto.
 */
const defesaTool = tool({
    description: 'Registra a defesa de cada achado. Chame exatamente uma vez, no fim.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            defesas: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        index: { type: 'number' },
                        posicao: { type: 'string', enum: ['defendido', 'concedido'] },
                        caminho: { type: 'string', description: 'A rota concreta que alcança a linha com o estado ruim, com file:line.' },
                        evidencia: { type: 'string', description: 'Os file:line que foram lidos e sustentam isso.' },
                    },
                    required: ['index', 'posicao', 'caminho', 'evidencia'],
                    additionalProperties: false,
                },
            },
        },
        required: ['defesas'],
        additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

/** Quatro fatos, não um julgamento. Dois deles (jaExistia, pedeDefesaSemChamador)
 *  são objetivos e baratos — um grep e uma olhada no diff — e cobrem a maior
 *  família de falso positivo que medimos. Na versão anterior apareciam como
 *  item de uma lista de quatro formas de refutar, e o refutador não tentava:
 *  disse NOT REFUTED nas 9 vezes em que se pronunciou. */
const ataqueTool = tool({
    description: 'Registra as checagens de cada achado. Chame exatamente uma vez, no fim.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            checagens: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        index: { type: 'number' },
                        temGuard: { type: 'string', enum: ['sim', 'nao', 'nao_verifiquei'] },
                        guardOnde: { type: 'string', description: 'file:line do guard, ou vazio.' },
                        jaExistia: { type: 'string', enum: ['sim', 'nao', 'nao_verifiquei'] },
                        jaExistiaPorque: { type: 'string' },
                        pedeDefesaSemChamador: { type: 'string', enum: ['sim', 'nao', 'nao_verifiquei'] },
                        simboloConfereComDescrito: { type: 'string', enum: ['sim', 'nao', 'nao_verifiquei'] },
                        simboloOnde: { type: 'string' },
                        conclusao: { type: 'string', enum: ['refutado', 'nao_refutado'] },
                    },
                    required: ['index', 'temGuard', 'guardOnde', 'jaExistia', 'jaExistiaPorque', 'pedeDefesaSemChamador', 'simboloConfereComDescrito', 'simboloOnde', 'conclusao'],
                    additionalProperties: false,
                },
            },
        },
        required: ['checagens'],
        additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const verdictTool = tool({
    description: 'Record the decision for every finding. Call exactly once.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            verdicts: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        index: { type: 'number' },
                        decision: { type: 'string', enum: ['keep', 'drop'] },
                        evidence: { type: 'string' },
                    },
                    required: ['index', 'decision', 'evidence'],
                    additionalProperties: false,
                },
            },
        },
        required: ['verdicts'],
        additionalProperties: false,
    }),
    execute: async () => ({ output: 'recorded' }),
});

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
    let TP = 0, FP = 0, GOLD = 0, KEPT = 0, DROP = 0;
    // Diagnóstico de execução. Sem isto, um juiz que nunca chamou a tool e um
    // juiz que decidiu manter tudo produzem exatamente o mesmo número — e a
    // conclusão "a estratégia não filtra" fica indistinguível de "o passo
    // quebrou".
    const diag = {
        paineis: 0, semDefesa: 0, semAtaque: 0, semVeredicto: 0,
        veredictosParciais: 0, erroNoTurno: 0,
        refutadoDito: 0, naoRefutadoDito: 0, checagens: {},
        toolCalls: 0, toolErros: 0, motivos: [],
    };
    const out = [];

    const rodarPR = async (cid, i) => {
        const brutos = pool[cid];
        let cands = brutos;
        if (!SEMDEDUP) {
            const ck = chaveDe(cid, brutos);
            if (cache[ck]) {
                cands = cache[ck].map((k) => brutos[k]).filter(Boolean);
            } else {
                try {
                    const d = await runDedup(brutos, undefined, { model, telemetry: tele('panel-dedup', { caseId: cid }) });
                    const idx = d.kept || brutos.map((_, k) => k);
                    cands = idx.map((k) => brutos[k]).filter(Boolean);
                    cache[ck] = idx;
                    fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
                } catch (e) { console.log(`   dedup falhou: ${String(e.message).slice(0, 50)}`); }
            }
        }
        let rt;
        // Ver a nota em dedup-then-verify.js: sem cleanup os worktrees se
        // acumulam ate o disco encher, e a falha aparece como "sem repo".
        let handle = null;
        try {
            handle = await prepareRepo(vars[cid], cid);
            if (handle) rt = tools(new LocalRepoCommands(handle.dir));
            else diag.motivos.push(`prepareRepo devolveu null para ${cid}`);
        } catch (e) {
            diag.motivos.push(`prepareRepo: ${String(e?.message || e).slice(0, 120)}`);
        }
        const diffs = Object.fromEntries(J(vars[cid].changedFilesFull).map((f) => [f.filename, f.patchWithLinesStr || '']));

        const porArquivo = {};
        for (const c of cands) (porArquivo[c.relevantFile || '?'] ||= []).push(c);

        const kept = [];
        const arquivos = Object.entries(porArquivo);
        for (let b = 0; b < arquivos.length; b += PAR) {
            const lote = await Promise.all(arquivos.slice(b, b + PAR).map(async ([file, lista]) => {
                if (!rt) return lista;
                const diff = String(diffs[file] || '(diff indisponivel)').slice(0, 9000);
                const run = async (prompt, extra) => {
                    const r = await generateText({
                        ...tele('panel-by-file'),
                        model, tools: { ...rt, ...(extra || {}) }, prompt,
                        stopWhen: (x) => (x.steps?.length ?? 0) >= MAXSTEPS,
                    });
                    for (const st of r.steps || []) {
                        for (const tc of st.toolCalls || []) diag.toolCalls++;
                        for (const tr of st.toolResults || []) {
                            if (/^(grep|readFile) failed:/.test(String(tr.output ?? tr.result ?? ''))) diag.toolErros++;
                        }
                    }
                    return r;
                };
                diag.paineis++;
                try {
                    const pega = (r, nome, campo) => {
                        const c = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === nome);
                        return (c?.input ?? c?.args)?.[campo] || null;
                    };
                    const d1 = await run(pDefensor(file, diff, lista), { defesas: defesaTool });
                    const defesas = pega(d1, 'defesas', 'defesas');
                    if (!defesas?.length) diag.semDefesa++;
                    const txtDefesa = JSON.stringify(defesas ?? [], null, 1).slice(0, 6000);

                    const d2 = await run(pRefutador(file, diff, lista, txtDefesa), { checagens: ataqueTool });
                    const checagens = pega(d2, 'checagens', 'checagens');
                    if (!checagens?.length) diag.semAtaque++;
                    for (const ch of checagens || []) {
                        ch.conclusao === 'refutado' ? diag.refutadoDito++ : diag.naoRefutadoDito++;
                        // Quantas das quatro checagens ele de fato fez — a
                        // diferenca entre "verifiquei e nao achei" e "nao olhei"
                        // e o que separa o filtro de nao filtrar nada.
                        for (const k of ['temGuard', 'jaExistia', 'pedeDefesaSemChamador', 'simboloConfereComDescrito']) {
                            diag.checagens[k] = diag.checagens[k] || { sim: 0, nao: 0, nao_verifiquei: 0 };
                            if (diag.checagens[k][ch[k]] != null) diag.checagens[k][ch[k]]++;
                        }
                    }
                    const txtAtaque = JSON.stringify(checagens ?? [], null, 1).slice(0, 6000);

                    const d3 = await run(pJuiz(file, lista, txtDefesa, txtAtaque), { verdicts: verdictTool });
                    const call = (d3.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'verdicts');
                    const vs = (call?.input ?? call?.args)?.verdicts || [];
                    if (!vs.length) { diag.semVeredicto++; return lista; }
                    if (vs.length < lista.length) diag.veredictosParciais++;
                    const drop = new Set(vs.filter((v) => v.decision === 'drop').map((v) => v.index));
                    return lista.filter((_, k) => !drop.has(k));
                } catch (e) {
                    diag.erroNoTurno++;
                    diag.motivos.push(`${file.split('/').pop()}: ${String(e?.message || e).slice(0, 160)}`);
                    console.log(`   turno falhou em ${file.slice(-40)}: ${String(e.message || e).slice(0, 110)}`);
                    return lista;
                }
            }));
            for (const l of lote) kept.push(...l);
        }
        KEPT += kept.length; DROP += cands.length - kept.length;

        const hit = new Set();
        for (const g of goldens[cid]) {
            for (const s of kept) {
                const txt = [s.oneSentenceSummary, s.suggestionContent].filter(Boolean).join('\n').slice(0, 1800);
                try { const v = await matchCommentDetailed(key, g.comment, txt); if (v?.match && (v.confidence ?? 0) >= 0.5) { hit.add(g.comment); break; } } catch {}
            }
        }
        TP += hit.size; FP += Math.max(kept.length - hit.size, 0); GOLD += goldens[cid].length;
        try { await handle?.cleanup?.(); } catch {}
        out.push({ caseId: cid, cands: cands.length, arquivos: arquivos.length, kept: kept.length, tp: hit.size, goldens: goldens[cid].length });
        console.log(`[${i + 1}/${ids.length}] ${cid.slice(0, 40).padEnd(42)} ${brutos.length}→dedup ${cands.length} em ${arquivos.length} arq → ${kept.length} · tp ${hit.size}/${goldens[cid].length}`);
    };
    for (let b = 0; b < ids.length; b += PARPR) {
        await Promise.all(
            ids.slice(b, b + PARPR).map((cid, k) =>
                comTrace(
                    {
                        traceName: `panel-by-file`,
                        sessionId: cid,
                        metadata: { caseId: cid, criterio: typeof CRIT !== 'undefined' ? CRIT : 'painel' },
                        tags: ['investigation', `panel-by-file`],
                    },
                    () => rodarPR(cid, b + k),
                ),
            ),
        );
    }
    const rec = TP / GOLD, pre = TP / Math.max(TP + FP, 1);
    fs.writeFileSync(OUT, JSON.stringify({ TP, FP, GOLD, recall: rec, precision: pre, mantidos: KEPT, descartados: DROP, diagnostico: diag, porPR: out }, null, 2));
    console.log(`\nDIAGNOSTICO DE EXECUCAO`);
    console.log(`  paineis: ${diag.paineis} · turnos com erro: ${diag.erroNoTurno}`);
    console.log(`  defensor vazio: ${diag.semDefesa} · refutador vazio: ${diag.semAtaque}`);
    console.log(`  juiz SEM chamar verdicts: ${diag.semVeredicto} · veredicto incompleto: ${diag.veredictosParciais}`);
    console.log(`  refutador concluiu refutado: ${diag.refutadoDito} · nao_refutado: ${diag.naoRefutadoDito}`);
    for (const [k, v] of Object.entries(diag.checagens)) {
        console.log(`    ${k.padEnd(26)} sim=${v.sim} nao=${v.nao} nao_verifiquei=${v.nao_verifiquei}`);
    }
    console.log(`  tool calls: ${diag.toolCalls} · retornaram erro: ${diag.toolErros}`);
    if (diag.motivos.length) {
        console.log(`  MOTIVOS DOS ERROS (${diag.motivos.length}):`);
        for (const m of diag.motivos) console.log(`    ${m}`);
    }
    console.log(`\nPAINEL POR ARQUIVO (defensor/refutador/juiz)`);
    console.log(`  mantidos ${KEPT} · descartados ${DROP}`);
    console.log(`  tp=${TP} fp=${FP} de ${GOLD} goldens`);
    console.log(`  recall=${rec.toFixed(3)}  precision=${pre.toFixed(3)}`);
    await flush();
    console.log(`\n-> ${OUT}`);
})();
