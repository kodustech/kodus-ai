#!/usr/bin/env node
/**
 * Marks suggestions no developer should ever receive: empty text or a
 * placeholder ("...", "test1"). Rule-based: fewer than 15 letters/digits in
 * suggestionContent. Text in another language is not unusable.
 *
 *   node evals/dedup/gold/mark-unusable.js
 */
const fs = require('fs');
const path = require('path');

const MIN_CHARS = 15;
let n = 0;
for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.json') && x !== 'human-overrides.json')) {
    const gold = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    if (!gold.prs) continue;
    for (const pr of Object.values(gold.prs)) {
        for (const s of pr.suggestions) {
            const text = (s.suggestionContent || '').trim();
            const chars = (text.match(/[\p{L}\p{N}]/gu) || []).length;
            if (chars < MIN_CHARS) {
                s.unusable = true;
                s.unusableReason = text ? 'placeholder' : 'empty';
                n++;
            } else {
                delete s.unusable;
                delete s.unusableReason;
            }
        }
    }
    fs.writeFileSync(path.join(__dirname, f), `${JSON.stringify(gold, null, 2)}\n`);
}
console.log(`unusable suggestions: ${n}`);
process.exit(0);
