import { RuntimeCommandName, RuntimeSuiteSelectionChangedSchema } from '@libs/runtime/contracts/runtime-commands';

import type { PgSuiteSelectionState } from '../suite/pg-suite-shadows';
import type { CommandHandler } from './command-handlers';

/** The selection state the change writes: the Runtime's own table, never the product's. */
export type SuiteSelectionWrites = Pick<PgSuiteSelectionState, 'reenable' | 'turnOff'>;

/**
 * `runtime.suite.selection_changed` (docs/runtime/e2e-suites.md section 6.1, D14): a person turns spec selection on or off for an
 * environment. On also lifts a brake the shadow check set and starts its window afresh, at the time the person asked. The product has
 * checked the environment is the organization's; the state write names the organization again, so another tenant's row never moves.
 */
export class SuiteSelectionChangedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.SuiteSelectionChanged;
    constructor(private readonly state: SuiteSelectionWrites) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeSuiteSelectionChangedSchema.safeParse(body);
        if (!p.success) return { invalid: 'invalid suite selection change', detail: p.error.message };
        const c = p.data;
        const at = new Date(c.requestedAt);
        if (c.selection === 'on') await this.state.reenable(c.organizationId, c.environmentId, at);
        else await this.state.turnOff(c.organizationId, c.environmentId, at);
        return undefined;
    }
}
