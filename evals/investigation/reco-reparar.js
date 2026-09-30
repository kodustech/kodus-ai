// Reprocessa as respostas com JSON malformado usando o reparo de producao (repairJsonText).
require('ts-node/register/transpile-only'); require('tsconfig-paths/register');
const fs = require('fs'), path = require('path');
const { repairJsonText, extractJsonFromText } = require(path.join(process.env.HOME, 'kodus-ai-bench-1821/libs/llm/structured-output-repair.ts'));
for (const f of process.argv.slice(2)) {
  const p = path.join(process.env.HOME, 'reco', f); const d = JSON.parse(fs.readFileSync(p, 'utf8')); let n = 0, falha = 0;
  for (const v of Object.values(d)) {
    if (!v.parseErro) continue;
    const bruto = extractJsonFromText(v.texto || '') || v.texto || '';
    try { const r = repairJsonText(bruto); const j = JSON.parse(r); v.suggestions = Array.isArray(j.suggestions) ? j.suggestions : []; v.parseErro = null; v.reparado = true; n++; }
    catch (e) { falha++; }
  }
  fs.writeFileSync(p, JSON.stringify(d)); console.log(f, 'reparados', n, 'irreparaveis', falha);
}
