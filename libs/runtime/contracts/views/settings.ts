import type { RuntimeWhoCanAsk } from '@libs/runtime/api/domain/ports';
import type { PartlyTestedCheck } from '@libs/runtime/contracts/enums';
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
    /** The org's own exercised-lines threshold, 0..100 (0: never held back); null: the default below applies. */
    exercisedLinesThresholdPercent: number | null;
    /** The deployment's threshold (RUNTIME_EXERCISED_LINES_THRESHOLD_PERCENT), what an org that set none gets. */
    exercisedLinesThresholdDefaultPercent: number;
    /**
     * US$ one hour of the org's own host costs; with it, the machine time of
     * the org's own cells is priced (a Run's cost, the Health card, the usage
     * report). Null: those machines are not priced.
     */
    machineUsdPerHostHour: number | null;
    /**
     * What the check of a partly tested Run with something left to decide
     * concludes: action_required, which a branch protection does not pass
     * (the default, also when null), or neutral, which it does.
     */
    partlyTestedCheck: PartlyTestedCheck | null;
    repositories: RuntimeRepositorySettingsView[];
}
