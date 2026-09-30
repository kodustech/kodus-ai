#!/usr/bin/env node
// Reconhecimento isolado: uma chamada por trecho (bug conhecido ou controle), sem ferramentas,
// com o system prompt e os blocos fixos do generalista de producao. --dry so monta e mede os prompts.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const fs = require('fs'), path = require('path'), os = require('os');
const dotenv = require('dotenv');
const R = path.join(os.homedir(), 'kodus-ai-bench-1821');
dotenv.config({ path: path.join(R, '.env') }); dotenv.config({ path: path.join(R, '.env.local'), override: true });
const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const MODEL = arg('model'), EFFORT = arg('effort'), OUT = arg('out'), DRY = process.argv.includes('--dry');
const LIMIT = Number(arg('limit', '0')), CONC = Number(arg('conc', '4')), CONDICAO = arg('cond', 'base');
const T = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'reco-template.json'), 'utf8'));
// --cond=auditor (H4): troca so o papel e a missao no system prompt — de "revisor" para "auditor
// que lista todo defeito, sem decidir qual merece comentario". O resto do prompt fica igual.
if (CONDICAO === 'auditor') {
  const ROLE_OLD = 'You are kodus-generalist-review-agent, Senior code reviewer specialized in finding correctness, security, and performance issues in one pass.';
  const ROLE_NEW = 'You are kodus-generalist-review-agent, a defect auditor. Your job is to list every defect in the changed code (correctness, security, performance), not to decide which ones deserve a review comment.';
  const MISSION_OLD = 'Find real, verifiable issues in the changed code in a single pass. You may report bug, security, or performance findings, but only when the evidence is concrete.';
  const MISSION_NEW = 'List every real defect you find in the changed code in a single pass, however small. Importance is recorded in severity; another stage decides what gets posted.';
  if (!T.system.includes(ROLE_OLD) || !T.system.includes(MISSION_OLD)) throw new Error('papel/missao nao encontrados no system prompt');
  T.system = T.system.replace(ROLE_OLD, ROLE_NEW).replace(MISSION_OLD, MISSION_NEW);
}
const CASOS = JSON.parse(fs.readFileSync(path.join(R, 'evals/investigation/results/reco-casos.json'), 'utf8'));
const SEM_FERRAMENTA = '  <Note>Tools are not available in this pass. The content of the changed file around the change is included above as <FileContent>, in the same numbered form readFile returns. Base your findings on the diff and that content.</Note>';
function prompt(c) {
  return ['<ReviewTask>', '', `  <PRContext>Title: ${c.prTitle}\n\n${c.prBody || ''}</PRContext>`, '',
    `  <Diffs>\n### ${c.file}\n\`\`\`diff\n${c.diff}\n\`\`\`\n</Diffs>`, '',
    `  <FileContent path="${c.file}" lines="${c.start}-${c.end}">\n${c.codigo}\n</FileContent>`, '',
    SEM_FERRAMENTA, '', T.task, '', T.rules, '', T.output, '</ReviewTask>'].join('\n');
}
async function main() {
  const casos = LIMIT ? CASOS.slice(0, LIMIT).concat(CASOS.filter((c) => c.tipo === 'controle').slice(0, LIMIT)) : CASOS;
  if (DRY) {
    const ch = casos.map((c) => (T.system.length + prompt(c).length));
    console.log(`casos ${casos.length} · chars medios ${Math.round(ch.reduce((a, b) => a + b, 0) / ch.length)} · max ${Math.max(...ch)} · ~tokens entrada totais ${Math.round(ch.reduce((a, b) => a + b, 0) / 3.6 / 1e3)}k`);
    fs.writeFileSync(path.join(os.homedir(), 'reco-exemplo.txt'), `SYSTEM(${T.system.length} chars)\n\n` + prompt(casos[0]));
    return;
  }
  const { generateText } = require('ai');
  const { buildModel } = require(path.join(R, 'evals/investigation/eval-model.js'));
  const { TIER0 } = require(path.join(R, 'evals/shared/tier0-models'));
  const { buildReasoningProviderOptions } = require(path.join(R, 'libs/llm/reasoning-options.ts'));
  const { extractJsonFromText } = require(path.join(R, 'libs/llm/structured-output-repair'));
  const model = buildModel(MODEL);
  const provider = TIER0[MODEL]?.provider || 'openai_compatible';
  const providerOptions = EFFORT ? buildReasoningProviderOptions(provider, EFFORT, TIER0[MODEL]?.doModel || MODEL) : undefined;
  const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const fila = casos.filter((c) => !res[c.id]);
  let i = 0;
  async function worker() {
    while (i < fila.length) {
      const c = fila[i++];
      for (let t = 0; t < 3; t++) {
        try {
          const r = await generateText({ model, system: T.system, messages: [{ role: 'user', content: prompt(c) }], providerOptions, maxRetries: 2 });
          let sug = null, erro = null;
          try { const j = JSON.parse(extractJsonFromText(r.text) || r.text); sug = Array.isArray(j.suggestions) ? j.suggestions : (typeof j.suggestions === 'string' ? JSON.parse(j.suggestions) : []); } catch (e) { erro = String(e).slice(0, 200); }
          res[c.id] = { tipo: c.tipo, caseId: c.caseId, file: c.file, cond: CONDICAO, finishReason: r.finishReason, usage: r.usage, texto: r.text, suggestions: sug, parseErro: erro };
          break;
        } catch (e) { res[c.id] = { tipo: c.tipo, erroChamada: String(e).slice(0, 300) }; await new Promise((s) => setTimeout(s, 3000 * (t + 1))); }
      }
      if (Object.keys(res).length % 10 === 0) fs.writeFileSync(OUT, JSON.stringify(res));
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  fs.writeFileSync(OUT, JSON.stringify(res));
  const v = Object.values(res); const u = v.reduce((a, x) => ({ i: a.i + (x.usage?.inputTokens || 0), o: a.o + (x.usage?.outputTokens || 0) }), { i: 0, o: 0 });
  console.log(`${MODEL} · ${v.length} casos · erros de chamada ${v.filter((x) => x.erroChamada).length} · parse falho ${v.filter((x) => x.parseErro).length} · finish ${JSON.stringify(v.reduce((a, x) => (a[x.finishReason] = (a[x.finishReason] || 0) + 1, a), {}))} · tokens in ${u.i} out ${u.o}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
