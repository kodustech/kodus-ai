import { RuntimeCommandName, RuntimeSuiteBaselineSkippedSchema } from '@libs/runtime/contracts/runtime-commands';

import type { PgSuiteBaselineRequests } from '../../shared/persistence/suite-baseline-requests';
import type { CommandHandler } from './command-handlers';

/** The baseline requests the command ends: the Runtime's own table, never the product's. */
export type SuiteBaselineRequestWrites = Pick<PgSuiteBaselineRequests, 'markSkipped'>;

/**
 * `runtime.suite.baseline_skipped` (docs/runtime/e2e-suites.md section 2.1): the product read a queued baseline request, found the
 * recipe at its main commit declares no suite to run, and says so. The request ends `skipped` with the reason, so the pass stops
 * seeing it and the environment page can say why there is no baseline. Only a queued request of that organization moves, so a
 * redelivery or a request that already started changes nothing.
 */
export class SuiteBaselineSkippedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.SuiteBaselineSkipped;
    constructor(private readonly requests: SuiteBaselineRequestWrites) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeSuiteBaselineSkippedSchema.safeParse(body);
        if (!p.success) return { invalid: 'invalid baseline skip', detail: p.error.message };
        await this.requests.markSkipped(p.data.organizationId, p.data.environmentId, p.data.mainSha, p.data.reason);
        return undefined;
    }
}
