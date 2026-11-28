import { Logger } from '@nestjs/common';

import { RuntimeCommandName, RuntimeSuiteRequestedSchema, type RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';

import type { CommandHandler } from './command-handlers';

/** What the handler asks of the suite engine: hold the work and return (a workflow in production, never awaited to its end). */
export interface SuiteStarter {
    start(cmd: RuntimeSuiteRequested): Promise<string | false>;
}

/**
 * `runtime.suite.requested` (docs/runtime/e2e-suites.md section 11): a baseline of a main commit, a PR's suite in CI
 * mode or in a Run. Only validates and enqueues; the suite engine plans, runs and stores it.
 */
export class SuiteRequestedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.SuiteRequested;
    private readonly logger = new Logger('SuiteRequested');
    constructor(private readonly suites: SuiteStarter) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeSuiteRequestedSchema.safeParse(body);
        if (!p.success) return { invalid: 'invalid suite request', detail: p.error.message };
        const id = await this.suites.start(p.data);
        if (id === false) this.logger.warn({ msg: 'suite.no_service', suiteRunId: p.data.suiteRunId });
        else this.logger.log({ msg: 'suite.enqueued', suiteRunId: p.data.suiteRunId, mode: p.data.mode, workflowId: id });
        return undefined;
    }
}
