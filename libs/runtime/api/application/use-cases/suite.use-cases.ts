import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import type { SignedEvidenceUrl } from '@libs/runtime/contracts/evidence';
import { suiteRunIdOfRun } from '@libs/runtime/contracts/derive-id';
import type { RuntimeEnvironmentSuiteView, RuntimeSuiteRunView } from '@libs/runtime/contracts/views/suite';

import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    type Clock,
    type ProductEnvironmentStore,
    type RuntimeApiConfig,
    type RuntimeEnvironmentSetupReader,
    type RuntimeGitPort,
} from '../../domain/ports';
import { RUNTIME_SUITE_READER, type RuntimeSuiteReader, type StoredSuiteRun } from '../../domain/suite';
import { environmentSuiteView, runSuiteView } from '../../domain/suite-view';
import { environmentRepositoryIds, RuntimeEnvironmentMembers } from '../environment-members.service';
import { signedEvidenceUrlOf } from '../evidence-url';
import { RuntimeRunAccessService, type RuntimeAuthorization } from '../run-access.service';
import { suiteDeclarationAt } from '../suite-recipe';
import { RuntimeSuiteRetrier } from '../suite-retrier.service';
import { RuntimeSuiteSelection } from '../suite-selection.service';
import { orgOf, validId } from './environment-view';

/** The red specs of the first pass: what "Re-run failed" runs again. */
const RED = new Set(['failed', 'infra', 'not_run']);

/** Loads the suite the worker named for the Run, or 404 when the Run has none: the suite of another organization is never read. */
async function suiteOf(reader: Pick<RuntimeSuiteReader, 'get'>, run: { organizationId: string; runId: string }): Promise<StoredSuiteRun> {
    const stored = await reader.get(run.organizationId, suiteRunIdOfRun(run.organizationId, run.runId));
    if (!stored || stored.run.organizationId !== run.organizationId) throw new NotFoundException('This Run has no e2e suite');
    return stored;
}

/**
 * GET /runtime/runs/:id/suite — the Run page's e2e suite tab (docs/runtime/e2e-suites.md section 13): the Run is loaded and checked like
 * the Run page (another organization's is 404), then the suite the worker named for it is read with the read-only role.
 */
@Injectable()
export class GetRuntimeRunSuiteUseCase {
    constructor(
        private readonly access: RuntimeRunAccessService,
        @Inject(RUNTIME_SUITE_READER) private readonly reader: RuntimeSuiteReader,
    ) {}

    async execute(input: { user: Partial<IUser>; runId: string }): Promise<RuntimeSuiteRunView> {
        const run = await this.access.load({ kind: 'user', user: input.user }, input.runId, Action.Read, ResourceType.RuntimeRun, 'columns');
        return runSuiteView(await suiteOf(this.reader, run));
    }
}

/**
 * POST /runtime/runs/:id/suite/retry — "Re-run failed": gated like "Run again" (it starts the repository's code again). A suite that still
 * runs, a run with nothing red and a recipe that no longer declares a suite are conflicts, answered before any token is minted.
 */
@Injectable()
export class RetryRuntimeRunSuiteUseCase {
    constructor(
        private readonly access: RuntimeRunAccessService,
        @Inject(RUNTIME_SUITE_READER) private readonly reader: RuntimeSuiteReader,
        private readonly retrier: RuntimeSuiteRetrier,
    ) {}

    async execute(input: { user: Partial<IUser>; runId: string }): Promise<{ suiteRunId: string; state: 'queued' }> {
        const run = await this.access.load({ kind: 'user', user: input.user }, input.runId, Action.Create, ResourceType.RuntimeRun, 'columns');
        const stored = await suiteOf(this.reader, run);
        if (!stored.run.finishedAt) throw new ConflictException('The suite is still running');
        if (!stored.results.some((r) => r.phase === 'shard' && RED.has(r.status))) throw new ConflictException('No spec of this suite is left to run again');
        const { suiteRunId } = await this.retrier.retryFailed({ user: input.user, run, suiteRunId: stored.run.suiteRunId, mainSha: stored.run.mainSha });
        return { suiteRunId, state: 'queued' };
    }
}

/**
 * GET /runtime/runs/:id/suite/artifacts — a URL of at most 5 minutes for a file kept for a failed spec. The key is the one the worker stored
 * for that spec and name, found here; a caller never names a key.
 */
@Injectable()
export class GetRuntimeRunSuiteArtifactUseCase {
    constructor(
        private readonly access: RuntimeRunAccessService,
        @Inject(RUNTIME_SUITE_READER) private readonly reader: RuntimeSuiteReader,
        @Inject(RUNTIME_API_CONFIG) private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK) private readonly now: Clock,
    ) {}

    async execute(input: { user: Partial<IUser>; runId: string; spec: string; name: string }): Promise<SignedEvidenceUrl & { key: string }> {
        const run = await this.access.load({ kind: 'user', user: input.user }, input.runId, Action.Read, ResourceType.RuntimeRun, 'columns');
        const stored = await suiteOf(this.reader, run);
        const artifact = stored.results.filter((r) => r.spec === input.spec).flatMap((r) => r.artifacts).find((a) => a.name === input.name);
        if (!artifact) throw new NotFoundException('No such artifact');
        return signedEvidenceUrlOf(this.config, artifact.key, this.now());
    }
}

/** The environment as the settings routes check it: another organization's is 404, then the right on every repository of the environment. */
async function environmentFor(
    environments: Pick<ProductEnvironmentStore, 'get'>,
    authorization: RuntimeAuthorization,
    members: RuntimeEnvironmentMembers | undefined,
    user: Partial<IUser>,
    environmentId: string,
    action: Action,
) {
    const organizationId = orgOf(user);
    const env = validId(environmentId) ? await environments.get(organizationId, environmentId) : null;
    if (!env || env.organizationId !== organizationId) throw new NotFoundException('Environment not found');
    await authorization.ensure({ user, action, resource: ResourceType.RuntimeEnvironment, repoIds: await environmentRepositoryIds(members, env) });
    return env;
}

/**
 * GET /runtime/environments/:id/suite — Settings, e2e suite: what the recipe declares at the environment's main commit (shown read-only),
 * the last baseline, whether selection is on or the shadow check paused it, and whether the suite runs on every push.
 */
@Injectable()
export class GetRuntimeEnvironmentSuiteUseCase {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE) private readonly environments: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(AuthorizationService) private readonly authorization: RuntimeAuthorization,
        @Inject(RuntimeEnvironmentMembers) private readonly members: RuntimeEnvironmentMembers,
        @Inject(RUNTIME_SUITE_READER) private readonly reader: RuntimeSuiteReader,
        @Inject(RUNTIME_GIT_PORT) private readonly git: Pick<RuntimeGitPort, 'readFileAtCommit'>,
        @Inject(RUNTIME_ENVIRONMENT_SETUP_READER) private readonly setups: Pick<RuntimeEnvironmentSetupReader, 'get'>,
        @Inject(RUNTIME_API_CONFIG) private readonly config: Pick<RuntimeApiConfig, 'suiteCi'>,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: string }): Promise<RuntimeEnvironmentSuiteView> {
        const env = await environmentFor(this.environments, this.authorization, this.members, input.user, input.environmentId, Action.Read);
        const mainSha = (await this.setups.get(env.organizationId, env.environmentId))?.sha;
        const repo = { organizationId: env.organizationId, teamId: env.teamId, repositoryId: env.repositoryId, repositoryName: env.repositoryName };
        const [recipe, selection, lastBaseline] = await Promise.all([
            mainSha ? suiteDeclarationAt(this.git, repo, mainSha) : undefined,
            this.reader.selectionState(env.organizationId, env.environmentId),
            this.reader.lastBaseline(env.organizationId, env.environmentId),
        ]);
        const braked = (selection.off && selection.offBy !== 'person') || selection.fullPrsLeft > 0;
        const miss = braked ? await this.reader.lastMiss(env.organizationId, env.environmentId, selection.reenabledAt) : null;
        return environmentSuiteView({
            environmentId: env.environmentId,
            ...(recipe ? { recipe: { runner: recipe.runner, specs: recipe.specs, command: recipe.command, ...(recipe.cwd ? { cwd: recipe.cwd } : {}), ...(recipe.results?.junit ? { results: { junit: recipe.results.junit } } : {}), ...(recipe.shards !== undefined ? { shards: recipe.shards } : {}), gate: recipe.gate, baseline: recipe.baseline } } : {}),
            lastBaseline,
            selection,
            miss,
            ci: { setting: env.suiteCi ?? null, deployment: !!this.config.suiteCi },
        });
    }
}

/**
 * POST /runtime/environments/:id/suite/selection/resume — "Resume selection": the same right as the environment's other settings (Manage).
 * It asks the Runtime through the outbox; the Runtime's selection state is never written from here.
 */
@Injectable()
export class ResumeSuiteSelectionUseCase {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE) private readonly environments: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(AuthorizationService) private readonly authorization: RuntimeAuthorization,
        @Inject(RuntimeEnvironmentMembers) private readonly members: RuntimeEnvironmentMembers,
        private readonly selection: RuntimeSuiteSelection,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: string }): Promise<{ state: 'requested' }> {
        const env = await environmentFor(this.environments, this.authorization, this.members, input.user, input.environmentId, Action.Manage);
        await this.selection.set({ user: input.user, organizationId: env.organizationId, environmentId: env.environmentId, selection: 'on' });
        return { state: 'requested' };
    }
}
