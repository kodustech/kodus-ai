// Capture a model's RAW structured-review return → a deterministic fixture for
// the return-shape corpus. Run ONCE per model you have a key for; the fixture
// then guards the parser (repairAndValidate) FOREVER with no live call, no flake.
//
//   node evals/structured-outputs/capture-return.js --model=kimi-k2.7-code@novita
//
// Intentionally uses PLAIN text generation (no native structured-output) so we
// capture how each model NATURALLY wraps JSON — fences, prose, thinking, trailing
// commas — which is exactly the disobedient shape the repair path must recover.
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
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v ?? true];
    }),
);
const MODEL = args.model;
if (!MODEL) {
    console.error('usage: node capture-return.js --model=<tier0 id>');
    process.exit(2);
}

const { applyModelEnv } = require('../shared/tier0-models');
const { buildEvalModel } = require('../shared/build-model');
const { generateText } = require('ai');

// A fixed review-shaped ask. The buggy diff makes every model WANT to emit one
// finding, so an empty return means the model misbehaved (which is also useful).
const PROMPT = `You are a senior code reviewer. Review the diff below.
Return ONLY a JSON object with this exact shape (no prose):
{"findings":[{"title": string, "severity": "low" | "medium" | "high"}]}

Diff:
+function add(a, b) {
+  return a - b; // intended to add
+}
`;

(async () => {
    try {
        applyModelEnv(MODEL);
    } catch (e) {
        console.error(`cannot route '${MODEL}': ${e.message}`);
        process.exit(2);
    }
    const model = buildEvalModel({});
    const r = await generateText({ model, prompt: PROMPT });
    const raw = r.text ?? '';

    const dir = path.join(__dirname, 'return-corpus');
    fs.mkdirSync(dir, { recursive: true });
    const safe = MODEL.replace(/[^\w.-]+/g, '-');
    const file = path.join(dir, `${safe}.json`);
    fs.writeFileSync(
        file,
        JSON.stringify(
            {
                model: MODEL,
                resolvedModel: process.env.API_LLM_PROVIDER_MODEL,
                finishReason: r.finishReason,
                raw,
            },
            null,
            2,
        ) + '\n',
    );
    console.log(
        `✅ captured ${raw.length} chars (finish=${r.finishReason}) -> ${path.relative(process.cwd(), file)}`,
    );
    console.log('--- raw preview (first 400) ---\n' + raw.slice(0, 400));
})().catch((e) => {
    console.error('capture failed:', e.message);
    process.exit(2);
});
