/**
 * A second labeller reviews proposed severity definitions and relabels: agree or
 * not, and the level it would give. Used to settle gold-v3 severity changes.
 *
 *   RECALL_MODEL=<tier0 id> node evals/severity/review-relabels.js <defs.md> <relabels.json> <out.json>
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });

require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { LLM } = require(path.join(__dirname, '../../libs/llm/llm.ts'));
const { createModel } = require('../investigation/agent-provider-1821');
const [defsFile, relFile, outFile] = process.argv.slice(2);
const defs = fs.readFileSync(defsFile, 'utf8');
const rel = JSON.parse(fs.readFileSync(relFile, 'utf8'));
const SCHEMA = z.object({
    definitionsCritique: z.string(),
    items: z.array(z.object({ issueId: z.string(), agree: z.boolean(), level: z.enum(['low', 'medium', 'high', 'critical']), reason: z.string() })),
});
(async () => {
    const model = await createModel({ provider: 'tier0' });
    const user = `We are writing the severity definitions of an AI code reviewer from a labelled dataset of real code-review problems, and fixing labels that are inconsistent. Another reviewer proposed the definitions below and a list of relabels. Review them independently.

=== PROPOSED DEFINITIONS ===
${defs}

=== PROPOSED RELABELS ===
Each entry: id, current label -> proposed label, the proposer's reason, and the problem description (the only thing the severity step sees).

${rel.map((r) => `[${r.issueId}] ${r.from} -> ${r.to}. Reason: ${r.astraReason}\nDescription: ${r.text}`).join('\n\n')}

For each entry: agree (true if the proposed label is right), level (the level you would give), and a one-sentence reason. Judge the description as stated, assuming it is true. Do not agree out of deference; keep the current label when the proposed change is a matter of taste.
Also give definitionsCritique: what in the definitions you would change and why (short).`;
    const out = await LLM.run({ system: 'You are a senior engineer who labels code-review findings by severity.', user, schema: SCHEMA, prebuiltModel: model, runName: 'severity-defs-review', maxTokens: 32000 });
    fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
    const n = out.items.filter((x) => x.agree).length;
    console.log(`agree ${n}/${out.items.length}`);
    process.exit(0);
})();
