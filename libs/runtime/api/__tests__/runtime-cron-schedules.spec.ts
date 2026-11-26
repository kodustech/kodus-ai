import { DEFAULT_MAX_TOKENS_PER_RUN } from '@libs/runtime/contracts/limits';

import { loadRuntimeApiConfig } from '../infrastructure/runtime-api.config';
import { loadRuntimeCronSchedules } from '../infrastructure/runtime-cron-schedules';

describe('Runtime product cron schedules', () => {
    it('runs each cron at its default interval when unset', () => {
        expect(loadRuntimeCronSchedules({})).toEqual({
            webhookReconciler: '*/10 * * * *',
            productRetention: '*/10 * * * *',
            prSessionSweep: '*/30 * * * *',
            poolScheduler: '*/5 * * * *',
            publicationRedrive: '* * * * *',
            pushSetupDrain: '*/2 * * * *',
        });
    });

    it('takes an operator schedule from its RUNTIME_CRON_* variable', () => {
        expect(loadRuntimeCronSchedules({ RUNTIME_CRON_POOL_SCHEDULER: '*/1 * * * *' }).poolScheduler).toBe('*/1 * * * *');
    });
});

describe('API tokens per Run', () => {
    it('defaults to the same limit as the worker', () => {
        expect(loadRuntimeApiConfig({}).llmBudget.perRun).toBe(DEFAULT_MAX_TOKENS_PER_RUN);
        expect(loadRuntimeApiConfig({ RUNTIME_MAX_TOKENS_PER_RUN: '  ' }).llmBudget.perRun).toBe(DEFAULT_MAX_TOKENS_PER_RUN);
    });
});
