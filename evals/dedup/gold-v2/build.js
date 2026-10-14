#!/usr/bin/env node
/**
 * Gold de duplicatas v2 (#1821): as sugestoes do finder definitivo de 09/10/26
 * (generalista + M3, sem verify, sem dedup, sem synthesis-rescue), uma entrada
 * por modelo, com ids S1..Sn por PR na ordem do finder.
 *
 *   node evals/dedup/gold-v2/build.js
 *   node evals/dedup/gold-v2/build.js --prefixo=<rotulo> --prs=<lista.json> --pools=<model>:<pool>,...
 */
const fs = require('fs');
const path = require('path');

const INV = path.join(__dirname, '..', '..', 'investigation');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const PREFIXO = arg('prefixo', '09.10.26');
const MODELOS_LIGHT = {
    'gpt-6.1-sol': '09.10.26_finder-definitivo_gpt',
    'sonnet-5.5': '09.10.26_finder-definitivo_sonnet',
    'deepseek-v4.1-flash': '09.10.26_finder-definitivo_deepseek',
    'muse-spark-1.2': '09.10.26_finder-muse-v1',
};
const MODELOS = arg('pools') ? Object.fromEntries(arg('pools').split(',').map((x) => x.split(':'))) : MODELOS_LIGHT;
const tecnica = (pb) => (pb === 'generalist-base' ? 'G' : String(pb || '').startsWith('micro-exp-p3-') ? 'M3' : null);
const L30 = JSON.parse(fs.readFileSync(arg('prs', path.join(INV, 'light-30.json')), 'utf8'));

for (const [model, pool] of Object.entries(MODELOS)) {
    const prs = {};
    let n = 0;
    for (const caseId of L30) {
        const raw = JSON.parse(fs.readFileSync(path.join(INV, 'pools', pool, `${caseId}.raw.txt`), 'utf8'));
        const cs = (raw.trace.preFilterCandidates || [])
            .map((c, k) => ({ c, k }))
            .filter(({ c }) => tecnica(c.producedBy));
        prs[caseId] = {
            suggestions: cs.map(({ c, k }, i) => ({
                id: `S${i + 1}`,
                finderIndex: k,
                producedBy: c.producedBy,
                technique: tecnica(c.producedBy),
                label: c.label,
                relevantFile: c.relevantFile,
                relevantLinesStart: c.relevantLinesStart,
                relevantLinesEnd: c.relevantLinesEnd,
                suggestionContent: c.suggestionContent,
            })),
        };
        n += cs.length;
    }
    const out = { model, sourcePool: pool, labelVersion: 'v2', prs };
    fs.writeFileSync(path.join(__dirname, `${PREFIXO}_${model}.json`), JSON.stringify(out, null, 1));
    console.log(`${model}: ${n} sugestoes em ${L30.length} PRs`);
}
