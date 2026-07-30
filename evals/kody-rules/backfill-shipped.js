/**
 * BEHAVIORAL test of the SHIPPED T0 compiler/backfill (#1449) against REAL prod
 * rules. This is exactly what BackfillRuleDetectorsUseCase does per rule (call
 * the shipped compileRuleDetector + gate), minus the DB persist — so it tells
 * us, on real customer rules: how many safely become a T0 regex vs stay
 * semantic, and lets us eyeball the compiled regexes + decline reasons.
 *
 *   node evals/kody-rules/backfill-shipped.js [--model=gpt-5.4-mini]
 *
 * Reads evals/kody-rules/prod-rules.json (gitignored — customer data). Nothing
 * is written or committed; rule titles print to your terminal only.
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
require.extensions['.ts'] = function (module, filename) {
    const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'es2021', sourcefile: filename,
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    });
    module._compile(code, filename);
};
require('tsconfig-paths/register');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
if (process.env.HOME) {
    dotenv.config({ path: path.join(process.env.HOME, '.kodus-dev/config'), override: true });
}
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v ?? true];
    }),
);
const MODELKEY = args.model || 'gpt-5.4-mini';

const raw = require('./prod-rules.json');
const rules = (Array.isArray(raw) ? raw : raw.rules || []).filter(
    (r) => r && r.rule && (r.type || 'standard').toLowerCase() !== 'memory',
);

const { compileRuleDetector, makeLLMRunCompiler } = require(
    '../../libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler.ts',
);

function parseCompilerJson(text) {
    if (!text) return null;
    let t = String(text).trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s >= 0 && e > s) t = t.slice(s, e + 1);
    try {
        return JSON.parse(t);
    } catch {
        return null;
    }
}

async function main() {
    const { applyModelEnv } = require('../shared/tier0-models');
    const { byokToVercelModel } = require('../../libs/llm/byok-to-vercel.ts');
    applyModelEnv(MODELKEY);
    const model = byokToVercelModel(undefined, 'main', {});
    const { generateText } = require('ai');

    let calls = 0;
    const runCompiler = makeLLMRunCompiler(async ({ system, user }) => {
        calls++;
        const res = await generateText({
            model,
            system,
            prompt: user,
            temperature: 0,
        });
        return parseCompilerJson(res.text);
    });

    let compiled = 0;
    let declined = 0;
    const reasons = {};
    for (const rule of rules) {
        const { detector, declineReason } = await compileRuleDetector(
            rule,
            runCompiler,
            { modelName: MODELKEY },
        );
        const title = String(rule.title || rule.uuid || '?').slice(0, 46);
        const cx = rule._complex ? ' [complex]' : '';
        if (detector) {
            compiled++;
            console.log(
                `✅ ${title.padEnd(46)}${cx} → /${detector.pattern}/${detector.flags || ''}`,
            );
        } else {
            declined++;
            reasons[declineReason] = (reasons[declineReason] || 0) + 1;
            console.log(
                `—  ${title.padEnd(46)}${cx} → semantic (${declineReason})`,
            );
        }
    }

    console.log(
        `\n════ SHIPPED compiler/backfill on REAL prod rules (${MODELKEY}) ════`,
    );
    console.log(
        `${compiled}/${rules.length} → T0 regex detector · ${declined}/${rules.length} → stay semantic (judge)`,
    );
    console.log(`decline reasons: ${JSON.stringify(reasons)}`);
    console.log(`LLM compile calls: ${calls}`);
    console.log(
        `\nNote: "stay semantic" is the SAFE default — a declined rule still works via the judge (100% recall). The gate only promotes a rule to regex when it reproduces the rule's own examples.`,
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});
