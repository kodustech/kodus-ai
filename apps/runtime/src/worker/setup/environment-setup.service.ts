import { z } from 'zod';

import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import { type EnvironmentSetupRecord, ExposeSchema, SETUP_AUTHOR_REPAIRS_DEFAULT } from '@libs/runtime/run';

import type { SetupConfig } from '../../shared/config';
import { SETUP_LEASE_UNAVAILABLE_RETRY_MS } from '../env/claim-liveness';
import { isCancellation } from '../workflow-cancellation';
import { authorRepair } from './author-repair';
import { bootOnce } from './boot-once';
import type { EnvironmentSetupStore } from './environment-setup.store';
import { learnFromSetup } from './learn-from-failure';
import { SetupLearnLoop } from './learn-loop';
import { refusedBeforeBoot, resolveRef } from './resolve-ref';
import { resolveRecipe } from './resolve-recipe';
import { atCommit, envFor, openSetup, settle, type SetupDeps, type SetupEnvFactory, type SetupExecutionOptions, type SetupExpose, type SetupOptions, type SetupRun, type SetupStepRunner } from './setup-scope';

// The setup of an environment (runtime.environment.setup_requested), run as
// a DBOS workflow (RunEngineService.startSetup): boot the default-branch head
// the product resolved, with the recipe the product read at that commit (§6),
// check that the exposed app answers, release the claim, and record each step
// and every blocker for Environment Health. Every I/O goes through `step` so
// a worker restart resumes after the last checkpoint instead of booting twice.
//
// S-52: the image bake is asked only for the default-branch head the product
// read from the Git API (never the dev override), only from the setup claim
// that booted it; the hub and the cell refuse a PR claim again. A failed
// setup keeps the cell's redacted failure bundle; with the org admin's
// diagnostic hold its machines stay until hardExpiresAt (§11 runbook).
//
// Each phase is a function of its own over the setup's scope (setup-scope.ts):
// resolve-ref.ts, resolve-recipe.ts, boot-once.ts, author-repair.ts and
// learn-from-failure.ts. The step ids each phase asks for, and their order,
// are the workflow's durable contract (environment-setup.step-ids.spec.ts).

export const ENVIRONMENT_SETUP_SERVICE = Symbol('ENVIRONMENT_SETUP_SERVICE');
export { ENVIRONMENT_SETUP_STORE, PgEnvironmentSetupStore } from './environment-setup.store';
export type { EnvironmentSetupStore } from './environment-setup.store';
export type { SetupEnvFactory, SetupExecutionOptions, SetupExpose, SetupOptions, SetupStepRunner } from './setup-scope';
export { carriedBuildCell, setupCorrelationId } from './setup-scope';
export { countSetupOutcome } from './setup-journal';
export { BUILD_TIMEOUT_TITLE, lastAuthoredRecipe, recipeFailureOf, repairFailureOf } from './recipe-failure';
export { BAKED_IMAGE, BOOT_PROGRESS_POLL_MS, cleanBootsOf, READY_CHECK_CEILING_MARGIN_SECONDS, SETUP_CAPACITY_WAIT_MS } from './boot-once';
export { BLOCKER_MESSAGE_MAX, blockerMessage, causeLine } from './blocker-message';
export { DEFAULT_HEALTH_TIMEOUT_SECONDS, HEALTH_RETRY_INTERVAL_SECONDS } from '../env/ready-check';

const direct: SetupStepRunner = (_name, fn) => fn();

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class EnvironmentSetupService {
    private readonly deps: SetupDeps;

    constructor(envs: SetupEnvFactory, store: EnvironmentSetupStore, opts: SetupOptions = {}) {
        const sleep = opts.sleep ?? realSleep;
        this.deps = {
            envs,
            store,
            opts,
            now: opts.now ?? (() => new Date()),
            sleep,
            leaseRetry: { unavailableRetryMs: SETUP_LEASE_UNAVAILABLE_RETRY_MS, sleep },
            repairs: opts.authorRepairs ?? SETUP_AUTHOR_REPAIRS_DEFAULT,
            ...(opts.learn ? { loop: new SetupLearnLoop(opts.learn) } : {}),
        };
    }

    /**
     * The setup workflow's body: the checks before any boot, the commit, the
     * recipe, then the boots (with Kody's repairs) and what the setup learns.
     * Deterministic for the workflow engine: every clock read is a step (a
     * resumed workflow replays the same times), and ids derive from the
     * command key.
     */
    async run(cmd: RuntimeEnvironmentSetupRequested, step: SetupStepRunner = direct, cancellationSignal?: () => AbortSignal | undefined, execution: SetupExecutionOptions = {}): Promise<EnvironmentSetupRecord> {
        const previous = await step('load', () => this.deps.store.get(cmd.environmentId));
        // Same command delivered twice: the first answer stands.
        if (previous && previous.key === cmd.key && previous.state !== 'setting_up') return previous;
        // A template build's setup keeps its record apart from the environment's.
        // (A step only for a template key, so an ordinary setup's step ids are unchanged.)
        if (cmd.key.startsWith('template:')) {
            const template = await step('load-template', async () => (await this.deps.store.getTemplate?.(cmd.key)) ?? null);
            if (template && template.state !== 'setting_up') return template;
        }

        const setup = openSetup(this.deps, cmd, previous, step, cancellationSignal, execution);
        await setup.journal.done(await setup.journal.start('requested'));
        if (await refusedBeforeBoot(setup)) return settle(setup);
        const sha = await resolveRef(setup);
        if (sha === undefined) return settle(setup);
        const run = atCommit(setup, sha);
        if (!(await resolveRecipe(run))) return settle(run);
        return bootAndRepair(run);
    }
}

/**
 * The setup's boots: its own, then one per repair of Kody's recipe while the
 * boot that just ended blocked on the recipe's account; then the setup ends
 * and, unless a boot lost its claim, learns from how it ended. A cancelled
 * setup neither ends nor learns here.
 */
async function bootAndRepair(run: SetupRun): Promise<EnvironmentSetupRecord> {
    const { rec } = run;
    let env = envFor(run);
    let cancelled = false;
    // Unset when a boot threw past its own catch: the setup is closed and learnt from, as before.
    let claimFailed: boolean | undefined;
    try {
        for (let attempt = 0; ; attempt++) {
            ({ claimFailed } = await bootOnce(run, env, attempt));
            const current = rec.repairs?.[attempt - 1];
            if (current) current.outcome = rec.state === 'blocked' ? 'blocked' : 'booted';
            if (rec.state !== 'blocked' || claimFailed || !(await authorRepair(run, attempt + 1))) break;
            env = envFor(run);
        }
        return rec;
    } catch (e) {
        if (isCancellation(e)) cancelled = true;
        throw e;
    } finally {
        if (!cancelled) {
            await settle(run);
            if (!claimFailed) await learnFromSetup(run, env);
        }
    }
}

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The worker's setup options from its config (loadSetupConfig, which reads
 * and bounds RUNTIME_SETUP_*); a malformed dev override fails the boot.
 */
export function setupOptionsFrom(c: SetupConfig): SetupOptions {
    const devSha = c.devSha?.trim() || undefined;
    if (devSha && !SHA_RE.test(devSha)) throw new Error('RUNTIME_SETUP_DEV_SHA must be a 40-hex commit SHA');
    let devExpose: SetupExpose | undefined;
    if (c.devExposeJson?.trim()) {
        let json: unknown;
        try {
            json = JSON.parse(c.devExposeJson);
        } catch {
            throw new Error('RUNTIME_SETUP_EXPOSE must be a JSON list of { service, port, kind }');
        }
        const parsed = z.array(ExposeSchema).max(32).safeParse(json);
        if (!parsed.success) throw new Error('RUNTIME_SETUP_EXPOSE must be a JSON list of { service, port, kind }');
        devExpose = parsed.data;
    }
    return { devSha, devExpose, healthPath: c.healthPath?.trim() || undefined, authorRepairs: c.authorRepairs };
}
