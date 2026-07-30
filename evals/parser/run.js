#!/usr/bin/env node
/**
 * Prose-findings recovery eval (Layer 2 — quality, uses a real LLM).
 *
 * The finder sometimes writes its findings as PROSE in `reasoning` and omits the
 * structured `suggestions` array (the Anthropic omission mode). The production
 * fallback `recoverFindingsFromProse` re-structures that prose into findings via
 * the internal model. This eval feeds REAL captured prose payloads through the
 * ACTUAL production function and checks the recovery is faithful:
 *   - it extracts at least the expected number of distinct findings
 *   - the recovered findings reference the files the prose talks about
 *
 * This is NOT a CI test (it calls a real LLM and is non-deterministic). The
 * deterministic wiring is covered by finder.agent.spec.ts. Run on demand:
 *
 *   # cloud path (gpt-5.4-mini):
 *   API_OPEN_AI_API_KEY=$BYOK_OPENAI_API_KEY node evals/parser/run.js
 *
 *   # a specific re-structurer model (mirrors BYOK/self-hosted resolution via
 *   # the tier0-models seam — one model per process so the json-schema cache
 *   # and env never leak between models):
 *   RECOVERY_MODEL=kimi-k2.7-code node evals/parser/run.js
 *   RECOVERY_MODEL=gemini-3-flash-preview node evals/parser/run.js
 */
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const fs = require('fs');
const path = require('path');

const { recoverFindingsFromProse } = require(
    path.join(
        __dirname,
        '../../libs/code-review/infrastructure/agents/core/finder.agent.ts',
    ),
);

async function main() {
    // Optional: point the internal (re-structurer) model at a specific tier-0
    // model, exactly as the self-hosted path resolves it. Omit -> cloud
    // gpt-5.4-mini (or whatever getInternalModel picks from the env).
    const model = process.env.RECOVERY_MODEL;
    if (model) {
        const { applyModelEnv } = require('../shared/tier0-models');
        applyModelEnv(model); // sets API_LLM_PROVIDER_MODEL + key + baseURL
    }
    console.log(`re-structurer model: ${model || '(cloud default gpt-5.4-mini)'}`);

    // Reachability probe. recoverFindingsFromProse swallows errors by design
    // (best-effort — it must never break a review), so in an eval a dead key or
    // an unreachable model would masquerade as "recovered 0 findings" (a quality
    // fail) instead of an infra error. Surface it here so ERROR != 0-findings.
    {
        const { getInternalModel } = require(
            path.join(__dirname, '../../libs/llm/byok-to-vercel.ts'),
        );
        const { generateObject } = require('ai');
        const { z } = require('zod');
        try {
            const m = getInternalModel(undefined, { structuredOutputs: true });
            if (!m) throw new Error('getInternalModel returned null (no key)');
            await generateObject({
                model: m,
                schema: z.object({ ok: z.string() }),
                prompt: 'Reply with {"ok":"yes"}.',
            });
        } catch (e) {
            console.log(
                `MODEL ERROR (${model || 'default'}): ${String(e.message || e).split('\n')[0].slice(0, 200)}`,
            );
            console.log('(unreachable / bad key — NOT a recovery-quality result)');
            process.exit(3);
        }
    }

    const fixtures = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'),
    );
    const org = 'prose-recovery-eval';
    let passed = 0;

    for (const fx of fixtures) {
        // byokConfig=undefined -> getInternalModel resolves the cloud/self-hosted
        // internal model exactly as production does.
        const found = await recoverFindingsFromProse(fx.prose, undefined, org);
        const files = found.map((s) => s.relevantFile || '');
        const countOk = found.length >= fx.expectMinFindings;
        const filesOk = (fx.expectFilesInclude || []).every((want) =>
            files.some((f) => f.includes(want)),
        );
        const ok = countOk && filesOk;
        if (ok) passed += 1;
        console.log(
            `${ok ? 'PASS' : 'FAIL'}  ${fx.id}  ` +
                `found=${found.length} (>=${fx.expectMinFindings}: ${countOk})  ` +
                `files=[${files.join(', ')}] (${filesOk})`,
        );
    }

    console.log(`\n${passed}/${fixtures.length} fixtures recovered faithfully`);
    process.exit(passed === fixtures.length ? 0 : 1);
}

main().catch((e) => {
    console.error('eval error:', e.message);
    process.exit(2);
});
