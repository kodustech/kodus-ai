// Jest setup (setupFilesAfterEnv) for the Business Logic live specs: resolves
// the model in EVAL_MODEL the way production resolves an org's for the
// businessValidation task (evals/shared/model-route.js), once, before the
// specs run. See evals/business-logic/live.js.
const path = require('path');

require('dotenv').config({
    path: path.join(__dirname, '../../.env'),
    quiet: true,
});

beforeAll(async () => {
    const modelId = process.env.EVAL_MODEL;
    if (!modelId) return;
    const {
        resolveRoute,
        evalPermissionService,
        EVAL_ORG,
    } = require('../shared/model-route');
    const { LLM_TASK } = require('../../libs/llm/llm-tasks.ts');
    const route = resolveRoute({ provider: 'tier0', model: modelId });
    const slot = await evalPermissionService(
        route.storedConfig,
    ).resolveTaskSlot(EVAL_ORG, LLM_TASK.businessValidation, { ctx: {} });
    if (!slot && route.storedConfig) {
        throw new Error(
            `${modelId}: production resolves no businessValidation slot for it`,
        );
    }
    globalThis.__BR_EVAL_MODEL__ = slot ?? undefined;
    process.stderr.write(
        `[business-logic live] ${modelId} via ${route.route} → ${slot?.provider ?? 'managed'}:${slot?.model ?? 'default'}\n`,
    );
}, 60_000);
