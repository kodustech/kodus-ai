import type { RuntimeMetrics } from '@libs/runtime/telemetry';
import type { EnvironmentSetupBlocker, EnvironmentSetupRecord, EnvironmentSetupStep, EnvironmentSetupStepName } from '@libs/runtime/run';

import { blockerMessage } from './blocker-message';
import type { EnvironmentSetupStore } from './environment-setup.store';
import type { SetupStepRunner } from './setup-scope';

/** A setup that ended: its outcome by where its recipe came from, and each blocker by kind and signature class. */
export function countSetupOutcome(metrics: RuntimeMetrics | undefined, rec: EnvironmentSetupRecord): void {
    if (!metrics || rec.state === 'setting_up') return;
    const origin = rec.recipe?.origin;
    const recipeOrigin = rec.recipe?.state !== 'found' ? 'none' : origin === 'inferred' || origin === 'authored' ? origin : 'committed';
    metrics.recordSetupOutcome(rec.state, { orgId: rec.organizationId, recipeOrigin });
    for (const b of rec.blockers) metrics.recordBlocker(b, { orgId: rec.organizationId, consumer: 'setup' });
}

/**
 * How one setup writes its record: every clock read is a step (`clock:<n>`)
 * and every save is one (`record:<n>`), numbered in the order they are asked,
 * so a resumed workflow replays the same times and the same saves. Deterministic
 * for the workflow engine: the numbering is part of the setup's step ids.
 */
export class SetupJournal {
    private clocks = 0;
    private saves = 0;
    // The state last saved: the save that first ends the setup counts its outcome, inside that save's
    // step, so a replayed workflow (whose steps return their recorded result) never counts it twice.
    private savedState: EnvironmentSetupRecord['state'] = 'setting_up';
    /** The repair of Kody's recipe the steps started from here belong to (0: the setup's first try). */
    repair = 0;

    constructor(
        private readonly rec: EnvironmentSetupRecord,
        private readonly step: SetupStepRunner,
        private readonly deps: { now: () => Date; store: EnvironmentSetupStore; metrics?: RuntimeMetrics },
    ) {}

    readonly clock = (): Promise<string> => this.step(`clock:${++this.clocks}`, async () => this.deps.now().toISOString());

    readonly save = async (rec: EnvironmentSetupRecord): Promise<void> => {
        rec.updatedAt = await this.clock();
        const copy = JSON.parse(JSON.stringify(rec)) as EnvironmentSetupRecord;
        const ends = this.savedState === 'setting_up' && copy.state !== 'setting_up';
        this.savedState = copy.state;
        await this.step(`record:${++this.saves}`, async () => {
            await this.deps.store.save(copy);
            if (ends) countSetupOutcome(this.deps.metrics, copy);
        });
    };

    async start(name: EnvironmentSetupStepName): Promise<EnvironmentSetupStep> {
        const s: EnvironmentSetupStep = { name, state: 'running', startedAt: await this.clock(), ...(this.repair ? { repair: this.repair } : {}) };
        this.rec.steps.push(s);
        await this.save(this.rec);
        return s;
    }

    async finish(s: EnvironmentSetupStep, state: EnvironmentSetupStep['state'], detail?: string): Promise<void> {
        const end = await this.clock();
        s.state = state;
        s.finishedAt = end;
        s.durationMs = Date.parse(end) - Date.parse(s.startedAt);
        if (detail) s.detail = detail.slice(0, 300);
        await this.save(this.rec);
    }

    done(s: EnvironmentSetupStep, detail?: string): Promise<void> {
        return this.finish(s, 'done', detail);
    }

    /** Ends the setup blocked on `b`, and fails the step `s` when it is still running. */
    async block(s: EnvironmentSetupStep | undefined, b: Omit<EnvironmentSetupBlocker, 'at'>): Promise<EnvironmentSetupRecord> {
        const at = await this.clock();
        this.rec.blockers.push({ ...b, message: blockerMessage(b.message), at });
        this.rec.state = 'blocked';
        this.rec.finishedAt = at;
        if (s && s.state === 'running') await this.finish(s, 'failed', b.message);
        return this.rec;
    }
}
