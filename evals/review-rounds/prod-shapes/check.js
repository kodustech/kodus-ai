// node evals/review-rounds/prod-shapes/check.js [cases/file.js] — every spec builds and can measure its claims.
const path = require('path');
const { loadSpecs, problems } = require('./index');
const { build } = require('./build');
const only = process.argv[2] && path.basename(process.argv[2]);
const specs = loadSpecs().filter((s) => !only || s.source === only);
let bad = 0;
const ids = new Set();
for (const s of specs) {
    const p = problems(s);
    if (ids.has(s.id)) p.push('duplicate id');
    ids.add(s.id);
    if (!/^P\d{2}-/.test(s.id)) p.push('id must start with P<two digits>-');
    try { build(s); } catch (e) { p.push(`build: ${e.message}`); }
    if (p.length) { bad++; console.log(`✗ ${s.id} (${s.source})\n  - ${p.join('\n  - ')}`); }
    else console.log(`✓ ${s.id}  ${s.agent}  ${s.shape}`);
}
console.log(`${specs.length - bad}/${specs.length} specs ok`);
process.exit(bad ? 1 : 0);
