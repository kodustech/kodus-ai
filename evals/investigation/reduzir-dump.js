#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Roda o reducer DE PRODUCAO sobre um dump que ja existe, e reescreve
 * `findings` + a trace no lugar.
 *
 * Existe porque a perna do reducer pode cair por rede (`getaddrinfo ENOTFOUND`)
 * depois de a geracao ter custado horas e milhoes de tokens. O dump guarda
 * `preFilterCandidates`, entao re-reduzir custa duas chamadas — re-gerar custa
 * a revisao inteira. Falha aberta preserva o dump original.
 *
 *   node reduzir-dump.js --dump=<pool> [--only=caseId] [--force]
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { reduceFindings } = require('../../libs/code-review/infrastructure/agents/engine/finding-reducer.ts');

const S = process.env.POOL_ROOT || path.join(__dirname, 'pools');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const DUMP = arg('dump');
const ONLY = (arg('only', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const FORCE = process.argv.includes('--force');
const MODEL = process.env.RECALL_MODEL || 'deepseek-v4.1-flash@fireworks';
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);

(async () => {
    const model = buildModel(MODEL);
    console.log(`[modelo] ${descreveModelo(MODEL)}`);
    const diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (v?.caseId)
                diffs[v.caseId] = J(v.changedFilesFull)
                    .map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || ''}`)
                    .join('\n\n');
        } catch {}
    }
    for (const f of fs.readdirSync(path.join(S, DUMP)).filter((x) => x.endsWith('.raw.txt'))) {
        const p = path.join(S, DUMP, f);
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (ONLY.length && !ONLY.includes(j.caseId)) continue;
        const st = j.trace?.dedup?.status;
        if (!FORCE && st !== 'failed-keep-all') {
            console.log(`  ${j.caseId.slice(0, 46).padEnd(48)} pula (status=${st})`);
            continue;
        }
        const cands = j.trace?.preFilterCandidates || [];
        const r = await reduceFindings({
            candidates: cands,
            diff: diffs[j.caseId] || '',
            log: (m) => console.log(`    ${m}`),
            call: async ({ schema, prompt }) => {
                const out = await generateText({
                    model,
                    prompt,
                    tools: {
                        registrar: tool({
                            description: 'Registra o resultado. Chame exatamente uma vez.',
                            inputSchema: jsonSchema(schema),
                            execute: async () => ({ output: 'ok' }),
                        }),
                    },
                    toolChoice: { type: 'tool', toolName: 'registrar' },
                });
                const c = (out.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'registrar');
                return c?.input ?? c?.args ?? {};
            },
        });
        if (r.trace.status === 'failed-keep-all') {
            console.log(`  ${j.caseId.slice(0, 46)} FALHOU DE NOVO, dump intacto: ${r.trace.errorMessage}`);
            continue;
        }
        j.findings = r.suggestions;
        j.trace.dedup = { status: r.trace.status, before: cands.length, after: r.suggestions.length, reducer: r.trace, refeitoOffline: true };
        fs.writeFileSync(p, JSON.stringify(j, null, 2));
        console.log(`  ${j.caseId.slice(0, 46).padEnd(48)} ${cands.length} -> ${r.suggestions.length} postados · gravado`);
    }
})().catch((e) => { console.error(e); process.exit(1); });
