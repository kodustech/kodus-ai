#!/usr/bin/env node
/**
 * Runs production's severity prompt (severity-prompt.ts, the one
 * classify-severity.ts sends) over the severity dataset and scores it per level.
 *
 *   RECALL_MODEL=<tier0 id> node evals/severity/run.js [--par=4] [--out=<file>]
 *
 * One call per PR with that PR's items, as production sends one call per
 * review. The suggestion text is taken as true: whether the problem exists is
 * the verifier's question, not this step's.
 *
 * Right answer per gold level: low, medium and high exact (critical for a high
 * is wrong); a critical answered high or critical is right (8 cases, too few to
 * tell those two apart).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const fs = require('fs');
const path = require('path');
const { LLM } = require(path.join(__dirname, '../../libs/llm/llm.ts'));
const { buildSeverityPrompt, parseSeverityResponse } = require(path.join(__dirname, '../../libs/code-review/infrastructure/agents/engine/severity-prompt.ts'));
const { createModel } = require('../investigation/agent-provider-1821');

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || d;
const MODEL = process.env.RECALL_MODEL;
const PAR = Number(arg('par', 4));
const OUT = arg('out', path.join(__dirname, 'results', `${(MODEL || '').replace(/[^\w.-]+/g, '_')}.json`));
if (!MODEL) {
    console.error('RECALL_MODEL=<id>');
    process.exit(2);
}
const LEVELS = ['low', 'medium', 'high', 'critical'];
const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset/items.json'), 'utf8')).items;
const right = (gold, got) => (gold === 'critical' ? got === 'high' || got === 'critical' : got === gold);

async function one(caseId, list, model) {
    const t0 = Date.now();
    try {
        const text = await LLM.run({
            user: buildSeverityPrompt(list.map((it) => ({ relevantFile: it.finding.relevantFile, suggestionContent: it.finding.suggestionContent }))),
            prebuiltModel: model,
            runName: 'eval-severity',
        });
        const { classifications, parseOk } = parseSeverityResponse(text || '');
        return list.map((it, i) => ({ issueId: it.issueId, gold: it.severity, got: parseOk ? classifications.get(i) ?? null : null, ms: Date.now() - t0 }));
    } catch (e) {
        return list.map((it) => ({ issueId: it.issueId, gold: it.severity, got: null, error: String(e?.message || e).slice(0, 200) }));
    }
}

(async () => {
    const model = await createModel({ provider: 'tier0' });
    const byCase = new Map();
    for (const it of items) (byCase.get(it.caseId) || byCase.set(it.caseId, []).get(it.caseId)).push(it);
    const todo = [...byCase];
    const rows = [];
    let i = 0;
    await Promise.all(Array.from({ length: PAR }, async () => {
        while (i < todo.length) {
            const [c, list] = todo[i++];
            rows.push(...(await one(c, list, model)));
        }
    }));
    const measured = rows.filter((r) => LEVELS.includes(r.got));
    const perLevel = Object.fromEntries(LEVELS.map((l) => {
        const xs = measured.filter((r) => r.gold === l);
        return [l, { n: xs.length, right: xs.filter((r) => right(r.gold, r.got)).length, got: Object.fromEntries(LEVELS.map((g) => [g, xs.filter((r) => r.got === g).length])) }];
    }));
    const far = measured.filter((r) => Math.abs(LEVELS.indexOf(r.gold) - LEVELS.indexOf(r.got)) >= 2).length;
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, perLevel, far, unmeasured: rows.length - measured.length, rows }, null, 1));
    console.log(MODEL);
    for (const l of LEVELS) console.log(`  ${l.padEnd(8)} ${perLevel[l].right}/${perLevel[l].n}  ${JSON.stringify(perLevel[l].got)}`);
    console.log(`  2+ levels off: ${far}  unmeasured: ${rows.length - measured.length}`);
    process.exit(rows.length - measured.length > rows.length * 0.05 ? 2 : 0);
})();
