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
    for (const f of fs.readdirSync(path.join(S, DUMP)).filter((x) => x.endsWith('.raw.txt'))) {
        const j = JSON.parse(fs.readFileSync(path.join(S, DUMP, f), 'utf8'));
        const cid = j.caseId;
        if (ONLY.length && !ONLY.includes(cid)) continue;
        const vars = casos[cid];
        if (!vars) { console.log(`  ${cid.slice(0, 44)} sem dataset`); continue; }

        const cands = j.trace?.preFilterCandidates || [];
        const keep = cands.map((c, i) => [c, i]).filter(([c]) => passesContract(c)).map(([, i]) => i);
        if (!keep.length) { saida[cid] = { grupos: [] }; continue; }
        const filtrados = keep.map((i) => cands[i]);
        const diff = J(vars.changedFilesFull)
            .map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || ''}`)
            .join('\n\n');

        // --- ATRIBUIDOR (mesmo prompt de producao) ---
        let grupos = [];
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
            continue;
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
            for (const g of grupos) {
                const cand = candidatoDoGrupo(g.indices.map((i) => filtrados[i]), g.indices.indexOf(g.representante));
                let v;
                try {
                    v = await verifier.verify(cand, { runId: `${cid}:${g.representante}` });
                } catch (e) {
                    // Falha aberta: um verify que quebra nao pode apagar o achado.
                    v = { keep: true, confidence: undefined, rationale: `verify falhou: ${String(e.message || e).slice(0, 120)}`, erro: true };
                }
                res.push({
                    indices: g.indices,
                    representante: g.representante,
                    origem: keep[g.representante],
                    nota: g.nota,
                    keep: v.keep !== false,
                    confidence: v.confidence,
                    erro: !!v.erro,
                    rationale: String(v.rationale || '').slice(0, 300),
                });
            }
            saida[cid] = { grupos: res, candidatos: keep.length };
            const mantidos = res.filter((r) => r.keep).length;
            console.log(`  ${cid.slice(0, 44).padEnd(46)} ${keep.length} cand -> ${res.length} grupos -> ${mantidos} keep`);
        } finally {
            await repo?.cleanup?.();
        }
        fs.writeFileSync(OUT, JSON.stringify({ dump: DUMP, modelo: MODEL, saida }, null, 2));
    }
    fs.writeFileSync(OUT, JSON.stringify({ dump: DUMP, modelo: MODEL, saida }, null, 2));
    console.log(`\n-> ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
