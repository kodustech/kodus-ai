#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/** Casa os comentarios do v001 que nao tem par exato no v002, usando o mesmo
 *  judge da metrica. O que sobrar sem par e discordancia real de anotacao. */
const fs = require('fs');
const path = require('path');
const { loadJudgeKey, matchCommentDetailed } = require('./recall-judge');
const norm = (s) => String(s || '').split(/\s+/).join(' ').toLowerCase();
(async () => {
    const v1 = JSON.parse(fs.readFileSync(path.join(__dirname, '../benchmark-sets/v001/goldens.json'), 'utf8'));
    const v2 = JSON.parse(fs.readFileSync(path.join(__dirname, '../benchmark-sets/v002/goldens.json'), 'utf8'));
    const idx = (v) => Object.fromEntries(v.prs.map((p) => [p.caseId, (p.comments || []).map((c) => (typeof c === 'string' ? c : c.comment))]));
    const A = idx(v1), B = idx(v2);
    const key = loadJudgeKey();
    let orf1 = 0, casou1 = 0, chamadas = 0;
    const sobra = [];
    for (const cid of Object.keys(A)) {
        if (!B[cid]) continue;
        const setB = new Set(B[cid].map(norm));
        const semPar = A[cid].filter((x) => !setB.has(norm(x)));
        for (const c of semPar) {
            orf1++;
            let achou = false;
            for (const b of B[cid]) {
                chamadas++;
                try { const r = await matchCommentDetailed(key, c, b); if (r?.match) { achou = true; break; } } catch {}
            }
            if (achou) casou1++; else sobra.push({ cid, c: String(c).slice(0, 110) });
        }
    }
    console.log(`\nv001 sem par EXATO: ${orf1}`);
    console.log(`  desses, o judge casou com algum do v002 (so reescrito): ${casou1}`);
    console.log(`  DESAPARECERAM de verdade: ${orf1 - casou1}`);
    console.log(`  (${chamadas} chamadas de judge)`);
    console.log(`\nexemplos do que sumiu:`);
    for (const s of sobra.slice(0, 8)) console.log(`   [${s.cid.slice(0, 34)}] ${s.c}`);
    fs.writeFileSync(path.join(__dirname, 'results', 'teto-anotacao.json'),
        JSON.stringify({ orf1, casou1, sumiram: orf1 - casou1, sobra }, null, 2));
})();
