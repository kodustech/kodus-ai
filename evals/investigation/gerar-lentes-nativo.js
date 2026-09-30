// Gera, por PR e por lente, o prompt da lente (buildMicroAgentPrompt de producao) com o diff no formato de producao,
// trocando o bloco <OutputFormat> pelo formato enxuto (arquivo, linha, problema).
require('ts-node/register/transpile-only'); require('tsconfig-paths/register');
const fs = require('fs');
const { MICRO_AGENTS, buildMicroAgentPrompt } = require('/home/ubuntu/kodus-ai-bench-1821/libs/code-review/infrastructure/agents/core/micro-agents.ts');
const IDS = ['says-one-thing-does-another','text-that-ships','invalid-state-and-concurrency','value-boundary-and-position','secret-and-identity','contract-not-followed','test-does-not-verify','data-exposure','changed-files-disagree'];
const PP = JSON.parse(fs.readFileSync('/home/ubuntu/native/prompts-prod.json','utf8'));
const LEAN = `<OutputFormat>
Answer with only a JSON array inside a \`\`\`json fence, one object per issue of your assigned class:
[{"file": "path/in/repo", "line": 123, "issue": "what is wrong and why it matters"}]
If you find no issue of your class, answer with an empty array.
</OutputFormat>`;
const out = {}; let faltou = [];
for (const [c, v] of Object.entries(PP)) {
  const u = v.user; const i = u.indexOf('<Diffs>'); const j = u.indexOf('</Diffs>', i);
  const diff = u.slice(i + '<Diffs>'.length, j).replace(/^\n/, '').replace(/\n\s*$/, '');
  out[c] = {};
  for (const id of IDS) {
    const g = MICRO_AGENTS.find((x) => x.id === id);
    if (!g) { faltou.push(id); continue; }
    let p = buildMicroAgentPrompt(g, diff, undefined, 4);
    const a = p.indexOf('<OutputFormat>'); const b = p.indexOf('</OutputFormat>');
    if (a < 0 || b < 0) throw new Error('sem OutputFormat em ' + id);
    p = p.slice(0, a) + LEAN + p.slice(b + '</OutputFormat>'.length);
    out[c][id] = p;
  }
}
fs.writeFileSync('/home/ubuntu/native/lentes-prompts.json', JSON.stringify(out));
const ex = out[Object.keys(out)[0]][IDS[0]];
console.log('PRs', Object.keys(out).length, '| lentes', IDS.length, '| faltaram', [...new Set(faltou)], '| chars exemplo', ex.length);
console.log(ex.slice(ex.indexOf('<Role>'), ex.indexOf('<Role>') + 400));
