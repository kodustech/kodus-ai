#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * ATRIBUIDOR -> VERIFY, sem formula.
 *
 * O reducer de hoje pontua com duas perguntas one-shot (nota e veracidade) e
 * corta por uma logistica de 8 termos. Este teste troca a segunda metade: o
 * atribuidor agrupa, e cada GRUPO vai para o `LlmVerifier` de producao — um
 * agente de verdade, com grep e readFile contra o repo, 5 ou 10 passos, que
 * responde `keep` + `confidence` + `rationale`.
 *
 * Roda sobre dumps que ja existem: `preFilterCandidates` esta gravado, entao
 * nada precisa ser re-gerado. O que muda e so o que acontece DEPOIS da
 * geracao.
 *
 * Por que vale medir mesmo o verify tendo sido removido do fluxo por machucar
 * recall (-5.7pp a -18.3pp em F1): naquele teste ele rodava por achado CRU,
 * antes de agrupar. Aqui ele julga o representante de um grupo ja consolidado,
 * que e outro regime.
 *
 *   node verify-apos-atribuidor.js --dump=<pool> --out=<arquivo> [--only=caseId]
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { prepareRepo } = require('./prepare-repo');
const { LocalRepoCommands } = require('./local-repo-commands');
const {
    passesContract,
    ATTRIBUTOR_SCHEMA,
    buildAttributorPrompt,
} = require('../../libs/code-review/infrastructure/agents/engine/finding-reducer.ts');
const { LlmVerifier } = require('../../libs/code-review/infrastructure/agents/core/verifier.agent.ts');
const { AiSdkAgentRunner } = require('../../libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner.ts');
const { buildFinderToolRegistry } = require('../../libs/code-review/infrastructure/agents/adapters/finder-tools.adapter.ts');

const S = process.env.POOL_ROOT || path.join(__dirname, 'pools');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const DUMP = arg('dump');
const OUT = arg('out', path.join(__dirname, 'results', `verify-${DUMP}.json`));
const ONLY = (arg('only', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
/** --grupos=<arquivo>: reaproveita o agrupamento de uma rodada anterior em vez
 *  de chamar o atribuidor de novo.
 *
 *  Nao e so economia de chamada. Comparar duas variantes do BUNDLE do verify
 *  exige que o agrupamento seja o mesmo nas duas: re-rodar o atribuidor sorteia
 *  grupos diferentes, e a diferenca medida passa a misturar o bundle com o
 *  agrupamento. */
const GRUPOS = arg('grupos');
/** Quantos PRs ao mesmo tempo. Cada PR abre um worktree do git, entao isto
 *  tambem e quantos clones ficam em disco ao mesmo tempo. */
const PARPR = Number(arg('parpr', '1'));
/** RECALL_VERIFY_SCORE=1: o verificador devolve 0-100 no lugar de keep/drop. */
const SCORE = process.env.RECALL_VERIFY_SCORE === '1';
/** RECALL_VERIFY_FALHA=1: pergunta se a FALHA pode ser instanciada. */
const FALHA = process.env.RECALL_VERIFY_FALHA === '1';
const MODEL = process.env.RECALL_MODEL || 'deepseek-v4.1-flash@fireworks';
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);

/** O grupo vira UM candidato: o representante, com as outras posicoes do mesmo
 *  defeito anexadas. E a mesma composicao que o reducer posta hoje, entao o
 *  verify julga exatamente o texto que o desenvolvedor receberia. */
function candidatoDoGrupo(membros, rep) {
    const base = { ...membros[rep] };
    // Guardado no proprio candidato para o `resolveGroupMembers` reencontrar:
    // o LlmVerifier so recebe o candidato, nao o grupo.
    Object.defineProperty(base, '__outros', {
        value: membros.filter((_, i) => i !== rep),
        enumerable: false,
    });
    const outras = membros
        .filter((_, i) => i !== rep)
        .map((m) => `${m.relevantFile}:${m.relevantLinesStart}-${m.relevantLinesEnd}`);
    if (outras.length) {
        base.suggestionContent =
            `${base.suggestionContent || ''}\n\nAlso found in:\n${[...new Set(outras)].map((l) => `- \`${l}\``).join('\n')}`;
    }
    return base;
}

(async () => {
    const model = buildModel(MODEL);
    console.log(`[modelo] ${descreveModelo(MODEL)}`);
    const casos = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (v?.caseId) casos[v.caseId] = v;
        } catch {}
    }
    const saida = {};
    const arquivos = fs
        .readdirSync(path.join(S, DUMP))
        .filter((x) => x.endsWith('.raw.txt'));
    const umCaso = async (f) => {
        const j = JSON.parse(fs.readFileSync(path.join(S, DUMP, f), 'utf8'));
        const cid = j.caseId;
        if (ONLY.length && !ONLY.includes(cid)) return;
        const vars = casos[cid];
        if (!vars) { console.log(`  ${cid.slice(0, 44)} sem dataset`); return; }

        const cands = j.trace?.preFilterCandidates || [];
        const keep = cands.map((c, i) => [c, i]).filter(([c]) => passesContract(c)).map(([, i]) => i);
        if (!keep.length) { saida[cid] = { grupos: [] }; return; }
        const filtrados = keep.map((i) => cands[i]);
        const diff = J(vars.changedFilesFull)
            .map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || ''}`)
            .join('\n\n');

        // --- ATRIBUIDOR (mesmo prompt de producao), ou o agrupamento reusado ---
        let grupos = [];
        if (GRUPOS) {
            const anterior = JSON.parse(fs.readFileSync(GRUPOS, 'utf8')).saida[cid];
            if (!anterior) { console.log(`  ${cid.slice(0, 44)} sem grupo na rodada anterior`); return; }
            grupos = (anterior.grupos || []).map((g) => ({
                indices: g.indices,
                representante: g.representante,
                nota: g.nota,
            }));
        } else {
        try {
            const out = await generateText({
                model,
                prompt: buildAttributorPrompt(filtrados, diff),
                tools: {
                    registrar: tool({
                        description: 'Registra os grupos. Chame exatamente uma vez.',
                        inputSchema: jsonSchema(ATTRIBUTOR_SCHEMA),
                        execute: async () => ({ output: 'ok' }),
                    }),
                },
                toolChoice: { type: 'tool', toolName: 'registrar' },
            });
            const call = (out.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'registrar');
            grupos = ((call?.input ?? call?.args)?.grupos || [])
                .map((g) => {
                    const idx = (g.indices || []).filter((i) => Number.isInteger(i) && i >= 0 && i < keep.length);
                    if (!idx.length) return null;
                    const rep = idx.includes(g.representante) ? g.representante : idx[0];
                    return { indices: idx, representante: rep, nota: Number(g.nota) || 0 };
                })
                .filter(Boolean);
        } catch (e) {
            console.log(`  ${cid.slice(0, 44)} atribuidor FALHOU: ${String(e.message || e).slice(0, 90)}`);
            return;
        }
        }

        // --- VERIFY por grupo, com ferramentas contra o repo de verdade ---
        let repo = null;
        try {
            repo = await prepareRepo(vars, cid);
            const remote = new LocalRepoCommands(repo.dir);
            const { registry: tools } = buildFinderToolRegistry({ remoteCommands: remote });
            const runner = new AiSdkAgentRunner(undefined, { prebuiltModel: model });
            const verifier = new LlmVerifier(runner, {
                modelId: String(MODEL).replace(/@.*$/, ''),
                tools,
                agentName: 'verify-pos-atribuidor',
                scoreMode: SCORE,
                failureMode: FALHA,
                // O prompt do modo score manda investigar antes de pontuar, e o
                // teto de 5 cortou 30% dos grupos antes de responderem. O passo
                // final (submeter) tambem consome um, entao 8 deixa 7 de
                // investigacao. RECALL_VERIFY_PASSOS ajusta sem recompilar.
                ...(SCORE || FALHA
                    ? {
                          lightMaxSteps: Number(process.env.RECALL_VERIFY_PASSOS) || 8,
                          fullMaxSteps: Number(process.env.RECALL_VERIFY_PASSOS) || 8,
                      }
                    : {}),
                // RECALL_VERIFY_REASON=1: manda o percurso do achado no bundle.
                includeReason: process.env.RECALL_VERIFY_REASON === '1',
                // RECALL_VERIFY_GRUPO=1: manda tambem a redacao e o percurso dos
                // OUTROS membros do grupo, como evidencia extra.
                ...(process.env.RECALL_VERIFY_GRUPO === '1'
                    ? {
                          resolveGroupMembers: (c) =>
                              (c.__outros || []).map((o) => ({
                                  relevantFile: o.relevantFile,
                                  relevantLinesStart: o.relevantLinesStart,
                                  relevantLinesEnd: o.relevantLinesEnd,
                                  suggestionContent: o.suggestionContent,
                                  reason: o.reason,
                              })),
                      }
                    : {}),
            });
            const res = [];
            const tPR = Date.now();
            for (const g of grupos) {
                const cand = candidatoDoGrupo(g.indices.map((i) => filtrados[i]), g.indices.indexOf(g.representante));
                let v;
                const tG = Date.now();
                try {
                    v = await verifier.verify(cand, { runId: `${cid}:${g.representante}` });
                } catch (e) {
                    // Falha aberta: um verify que quebra nao pode apagar o achado.
                    v = { keep: true, confidence: undefined, rationale: `verify falhou: ${String(e.message || e).slice(0, 120)}`, erro: true };
                }
                res.push({
                    ms: Date.now() - tG,
                    indices: g.indices,
                    representante: g.representante,
                    origem: keep[g.representante],
                    nota: g.nota,
                    keep: v.keep !== false,
                    score: v.score,
                    trigger: v.trigger,
                    confidence: v.confidence,
                    erro: !!v.erro,
                    rationale: String(v.rationale || '').slice(0, 300),
                });
            }
            saida[cid] = { grupos: res, candidatos: keep.length, ms: Date.now() - tPR };
            const mantidos = res.filter((r) => r.keep).length;
            console.log(`  ${cid.slice(0, 44).padEnd(46)} ${keep.length} cand -> ${res.length} grupos -> ${mantidos} keep`);
        } finally {
            await repo?.cleanup?.();
        }
        fs.writeFileSync(OUT, JSON.stringify({ dump: DUMP, modelo: MODEL, saida }, null, 2));
    };
    // Em lotes de PARPR. Cada PR abre o proprio worktree, entao o paralelismo
    // custa disco e memoria — por isso e parametro e nao padrao.
    for (let b = 0; b < arquivos.length; b += PARPR) {
        await Promise.all(arquivos.slice(b, b + PARPR).map(umCaso));
    }
    fs.writeFileSync(OUT, JSON.stringify({ dump: DUMP, modelo: MODEL, saida }, null, 2));
    console.log(`\n-> ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
