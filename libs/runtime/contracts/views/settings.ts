import type { RuntimeWhoCanAsk } from '@libs/runtime/api/domain/ports';
import type { RuntimeMode, TriggerRule } from '@libs/runtime/api/domain/trigger-rules';

// What GET /runtime/settings answers: types only, shared by the use cases
// (api/application/use-cases/settings.use-cases.ts) and the web.

export interface RuntimeRepositorySettingsView {
    repositoryId: string;
    repositoryName?: string;
    pilot: boolean;
    whoCanAsk: RuntimeWhoCanAsk;
    mode: RuntimeMode;
    rules: TriggerRule[];
    runOnAgentPullRequests: boolean;
    runOnNewPushes: boolean;
}

export interface RuntimeSettingsView {
    tokenBudgetPerDay: number | null;
    repositories: RuntimeRepositorySettingsView[];
}
