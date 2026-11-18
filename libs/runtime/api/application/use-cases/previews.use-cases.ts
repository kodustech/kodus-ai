import type { KeyObject } from 'crypto';

import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    environmentPreviewIdFor,
    isPreviewReturnPath,
    PREVIEW_DISABLED_CODE,
    PREVIEW_ID_PATTERN,
    PREVIEW_OFF_CODE,
    PREVIEW_REASONS,
    PREVIEW_SESSION_PATH,
    PREVIEW_SIDES,
    type PreviewPolicy,
    type PreviewSecrets,
    type PreviewSettings,
    type PreviewSide,
    PreviewSideSchema,
    previewIdFor,
    previewTokenBinding,
    signPreviewGrant,
    type PreviewView,
} from '@libs/runtime/contracts/preview';
import type { RuntimeRunProjection } from '@libs/runtime/run/run-projection';
import { isTerminal } from '@libs/runtime/run/run-state';
import { RUNTIME_RUN_TARGET_STORE_TOKEN, type RunTargetStore } from '@libs/runtime-publish/domain/run-target';

import { EnvSessionPortError } from '../../domain/env-tools';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_REPO_TOKEN_ISSUER,
    type Clock,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    type RuntimeApiConfig,
    type RuntimeEnvironmentSetupReader,
    type RuntimeGitPort,
    type RuntimeRepoTokenIssuer,
} from '../../domain/ports';
import {
    previewGrantKeyFrom,
    RUNTIME_PREVIEW_PORT,
    RUNTIME_PREVIEW_SETTINGS_STORE,
    type RuntimePreviewPort,
    type RuntimePreviewSettingsStore,
} from '../../domain/previews';
import { RuntimeRunAccessService } from '../run-access.service';
import { sealForRuntime } from '../secret-sealer';

// Preview URLs, the API side (docs/runtime/preview-urls.md §6.1, §9.3). Every
// route loads the Run (or the environment) behind the preview and checks the
// caller's role on RuntimePreview with the repo scope of every repository of
// its environment (repo-scoped for every role but owner, decision 7). A
// preview, Run or environment of another org answers 404. The worker owns the
// record; the API only opens, reads and stops it through the worker, decides
// the policy of each open from the org's settings, and mints the single-use
// grant the preview edge exchanges for its cookie.

export const FORK_PREVIEW_OFF = PREVIEW_REASONS.forkOff;
export const PREVIEW_DEPLOYMENT_OFF = 'Previews are off on this deployment. Set RUNTIME_PREVIEW_DOMAIN to a domain other than the one Kodus runs on.';
export const PREVIEW_REFUSALS_TEXT = {
    halted: 'This Run was stopped by a security event, so it has no preview.',
    unfinished: 'The preview opens once this Run has finished.',
    multiRepository: 'Previews of environments with more than one repository are not available yet. Open the Run page of each repository instead.',
    noSetup: 'This environment has no finished setup yet. Set it up first, then preview it.',
    forkNotTested: "A fork's PR version opens only for a Run that tested it, after a maintainer approved it.",
} as const;

type User = Partial<IUser>;

/** Whether a preview can open now, and if not, the sentence the product shows. */
export interface PreviewOffer {
    available: boolean;
    /** Why not, for the viewer; absent when available. */
    reason?: string;
    /** preview_off (the deployment), preview_disabled (the org), or a refusal of this Run or environment. */
    code?: string;
    /** The PR side only: why it cannot open while the base side can (a fork's). */
    prReason?: string;
    idleMinutes: number;
    ceilingMinutes: number;
    secrets: PreviewSecrets;
}

export interface RunPreviewsView {
    offer: PreviewOffer;
    /** Each side's preview once it was opened; absent: never opened. */
    sides: Partial<Record<PreviewSide, PreviewView>>;
}

export interface EnvironmentPreviewView {
    offer: PreviewOffer;
    /** The commit the last setup baked: what the preview opens at. */
    sha?: string;
    preview?: PreviewView;
}

const notFound = () => new NotFoundException('Preview not found');

/** The worker's refusal as an HTTP error of the product: 404 stays 404, the rest keeps its code and message. */
function fromPort(e: unknown): never {
    if (e instanceof EnvSessionPortError) {
        if (e.status === 404) throw notFound();
        throw new HttpException({ code: e.code, message: e.message }, e.status);
    }
    throw e;
}

/** A Run that tested its commit: the only kind whose fork PR side may open (the approval gate passed for that sha). */
const TESTED = new Set(['no_regressions', 'regression', 'partly_tested']);

@Injectable()
export class RuntimePreviewsService {
    private readonly logger = new Logger('RuntimePreviews');
    private grantKey?: KeyObject;

    constructor(
        private readonly access: RuntimeRunAccessService,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: Pick<RuntimeGitPort, 'getPullRequestHead'>,
        @Inject(RUNTIME_REPO_TOKEN_ISSUER)
        private readonly repoTokens: RuntimeRepoTokenIssuer,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: Pick<RuntimeApiConfig, 'secretSealKey' | 'previewGrantPrivateKey' | 'previewPublicPort' | 'previewDomain'>,
        @Inject(RUNTIME_PREVIEW_PORT)
        private readonly previews: RuntimePreviewPort,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        @Inject(AuthorizationService)
        private readonly authorization: Pick<AuthorizationService, 'check' | 'ensure'>,
        @Inject(RUNTIME_PREVIEW_SETTINGS_STORE)
        private readonly settings: RuntimePreviewSettingsStore,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(RUNTIME_ENVIRONMENT_SETUP_READER)
        private readonly setups: RuntimeEnvironmentSetupReader,
        @Inject(RUNTIME_RUN_TARGET_STORE_TOKEN)
        private readonly targets: Pick<RunTargetStore, 'get'>,
    ) {}

    /** The deployment offers previews only with its preview domain and the grant key (decision 1). */
    private deploymentOn(): boolean {
        return !!this.config.previewDomain && !!this.config.previewGrantPrivateKey;
    }

    private async environmentOf(organizationId: string, environmentId: string): Promise<ProductEnvironment | null> {
        const env = await this.environments.get(organizationId, environmentId).catch(() => {
            throw new ServiceUnavailableException('The environment could not be read. Try again.');
        });
        return env && env.organizationId === organizationId ? env : null;
    }

    private baseOffer(settings: PreviewSettings, env: ProductEnvironment | null): PreviewOffer {
        const common = { idleMinutes: settings.idleMinutes, ceilingMinutes: settings.ceilingMinutes, secrets: env?.previewSecrets ?? 'none' } as const;
        if (!this.deploymentOn()) return { available: false, code: PREVIEW_OFF_CODE, reason: PREVIEW_DEPLOYMENT_OFF, ...common };
        if (!settings.enabled) return { available: false, code: PREVIEW_DISABLED_CODE, reason: PREVIEW_REASONS.disabled, ...common };
        return { available: true, ...common };
    }

    /** What a Run's preview card shows: whether it can open and why not, from facts already stored (the fork flag the product kept). */
    private async runOffer(run: RuntimeRunProjection, settings: PreviewSettings, env: ProductEnvironment | null): Promise<PreviewOffer> {
        const offer = this.baseOffer(settings, env);
        if (!offer.available) return offer;
        const refuse = (code: string, reason: string): PreviewOffer => ({ ...offer, available: false, code, reason });
        if (run.state === 'halted') return refuse('run_halted', PREVIEW_REFUSALS_TEXT.halted);
        if (!isTerminal(run.state)) return refuse('run_unfinished', PREVIEW_REFUSALS_TEXT.unfinished);
        // The worker boots one repository per preview; a multi-repository environment boots whole (a later phase).
        if ((await this.access.repositoryIdsOf(run)).length > 1) return refuse('multi_repository', PREVIEW_REFUSALS_TEXT.multiRepository);
        // The stored flag only shapes the card; opening reads the fork from the Git API (forkOf), unknown as a fork.
        const fork = (await this.targets.get(run.runId, { organizationId: run.organizationId }).catch(() => null))?.fork;
        if (fork === true) {
            if (settings.forks === 'off') return { ...offer, prReason: FORK_PREVIEW_OFF };
            if (!TESTED.has(run.state)) return { ...offer, prReason: PREVIEW_REFUSALS_TEXT.forkNotTested };
        }
        return offer;
    }

    /** GET /runtime/runs/:runId/previews: the card of the Run page, both sides and whether they can open. */
    async forRun(user: User, runId: string): Promise<RunPreviewsView> {
        const run = await this.access.load({ kind: 'user', user }, runId, Action.Read, ResourceType.RuntimePreview);
        const [settings, env] = await Promise.all([this.settings.getPreviewSettings(run.organizationId), this.environmentOf(run.organizationId, run.environmentId)]);
        const offer = await this.runOffer(run, settings, env);
        const sides: RunPreviewsView['sides'] = {};
        for (const side of PREVIEW_SIDES) {
            // A side whose status cannot be read shows as not open; opening it asks the cell again.
            const view = await this.previews.previewStatus({ organizationId: run.organizationId, previewId: previewIdFor(run.organizationId, run.runId, side) }).catch(() => null);
            if (view && view.runId === run.runId) sides[side] = view;
        }
        return { offer, sides };
    }

    /** POST /runtime/runs/:runId/previews: open (or find) the preview of one side of a finished Run. */
    async open(user: User, runId: string, sideInput: unknown): Promise<PreviewView> {
        const side = PreviewSideSchema.safeParse(sideInput);
        if (!side.success) throw new BadRequestException('side must be pr or base');
        const run = await this.access.load({ kind: 'user', user }, runId, Action.Read, ResourceType.RuntimePreview);
        const [settings, env] = await Promise.all([this.settings.getPreviewSettings(run.organizationId), this.environmentOf(run.organizationId, run.environmentId)]);
        if (!settings.enabled) throw new ConflictException({ code: PREVIEW_DISABLED_CODE, message: PREVIEW_REASONS.disabled });
        if (run.state === 'halted') throw new ConflictException(PREVIEW_REFUSALS_TEXT.halted);
        if (!isTerminal(run.state)) throw new ConflictException(PREVIEW_REFUSALS_TEXT.unfinished);
        if ((await this.access.repositoryIdsOf(run)).length > 1) throw new ConflictException(PREVIEW_REFUSALS_TEXT.multiRepository);
        const orgTeam = { organizationId: run.organizationId, teamId: run.teamId };
        const repo = { repositoryId: run.repositoryId, repositoryName: run.repositoryName };
        const fork = side.data === 'pr' ? await this.forkOf(run, orgTeam, repo) : false;
        if (fork) {
            // Decision 6: off by default; when on, members only, and only a commit a Run tested after the approval gate.
            if (settings.forks === 'off') throw new ConflictException(FORK_PREVIEW_OFF);
            if (!TESTED.has(run.state)) throw new ConflictException(PREVIEW_REFUSALS_TEXT.forkNotTested);
        }

        const previewId = previewIdFor(run.organizationId, run.runId, side.data);
        const view = await this.previews
            .openPreview({
                organizationId: run.organizationId,
                previewId,
                runId: run.runId,
                prNumber: run.prNumber,
                environmentId: run.environmentId,
                repositoryId: run.repositoryId,
                repositoryFullName: run.repositoryName,
                side: side.data,
                sha: side.data === 'pr' ? run.headSha : run.baseSha,
                sealedRepoToken: await this.sealedToken(orgTeam, repo, previewId),
                openedBy: user.uuid!,
                policy: this.policyOf(settings, env, fork),
            })
            .catch(fromPort);
        // Defense in depth over the worker's own scoping: the answer must be this Run's preview.
        if (view.previewId !== previewId || view.runId !== run.runId) throw notFound();
        return view;
    }

    private policyOf(settings: PreviewSettings, env: ProductEnvironment | null, fork: boolean): PreviewPolicy {
        return {
            idleMinutes: settings.idleMinutes,
            ceilingMinutes: settings.ceilingMinutes,
            // Decision 4: none unless an owner set the environment to "same as the Run"; never a fork's PR side.
            secrets: env?.previewSecrets === 'run' && !fork,
            forkPullRequest: fork,
            ...(settings.monthlyMachineMinutes ? { monthlyMachineMinutes: settings.monthlyMachineMinutes } : {}),
        };
    }

    private async sealedToken(orgTeam: { organizationId: string; teamId: string }, repo: { repositoryId: string; repositoryName: string }, previewId: string): Promise<string> {
        let token: string;
        try {
            token = await this.repoTokens.issue({ ...orgTeam, ...repo });
        } catch {
            throw new ServiceUnavailableException('Kodus could not issue the download token for this repository.');
        }
        return sealForRuntime(this.config, token, previewTokenBinding(previewId));
    }

    /**
     * Whether the PR is a fork's comes from the Git API, never from a stored
     * flag; an unknown answer counts as a fork (the safe side).
     */
    private async forkOf(run: RuntimeRunProjection, orgTeam: { organizationId: string; teamId: string }, repo: { repositoryId: string; repositoryName: string }): Promise<boolean> {
        let fork: boolean | undefined;
        try {
            fork = (await this.git.getPullRequestHead({ ...orgTeam, ...repo, prNumber: run.prNumber }))?.fork;
        } catch {
            throw new ServiceUnavailableException('Kodus could not read the pull request. Try again.');
        }
        return fork !== false;
    }

    /** The environment, if it is the caller's to preview: every repository of it in the caller's repo scope. */
    private async loadEnvironment(user: User, environmentId: string): Promise<ProductEnvironment> {
        const organizationId = user.organization?.uuid;
        const env = organizationId && typeof environmentId === 'string' && environmentId.length <= 128 ? await this.environmentOf(organizationId, environmentId) : null;
        if (!env) throw new NotFoundException('Environment not found');
        const repoIds = await this.access.repositoryIdsOf({ organizationId: env.organizationId, environmentId: env.environmentId, repositoryId: env.repositoryId });
        await this.authorization.ensure({ user, action: Action.Read, resource: ResourceType.RuntimePreview, repoIds });
        return env;
    }

    /** The environment's own preview: its base side at the commit the last setup baked (§8.3). */
    private async environmentFacts(user: User, environmentId: string) {
        const env = await this.loadEnvironment(user, environmentId);
        const [settings, setup, repoIds] = await Promise.all([
            this.settings.getPreviewSettings(env.organizationId),
            this.setups.get(env.organizationId, env.environmentId).catch(() => {
                throw new ServiceUnavailableException('The environment setup could not be read. Try again.');
            }),
            this.access.repositoryIdsOf({ organizationId: env.organizationId, environmentId: env.environmentId, repositoryId: env.repositoryId }),
        ]);
        const baked = setup && setup.organizationId === env.organizationId && setup.state === 'active' && setup.sha ? setup.sha : undefined;
        let offer = this.baseOffer(settings, env);
        if (offer.available && repoIds.length > 1) offer = { ...offer, available: false, code: 'multi_repository', reason: PREVIEW_REFUSALS_TEXT.multiRepository };
        else if (offer.available && !baked) offer = { ...offer, available: false, code: 'no_setup', reason: PREVIEW_REFUSALS_TEXT.noSetup };
        return { env, settings, baked, offer };
    }

    /** GET /runtime/environments/:environmentId/previews */
    async forEnvironment(user: User, environmentId: string): Promise<EnvironmentPreviewView> {
        const { env, baked, offer } = await this.environmentFacts(user, environmentId);
        if (!baked) return { offer };
        // As a Run's side: unreadable shows as not open.
        const view = await this.previews.previewStatus({ organizationId: env.organizationId, previewId: environmentPreviewIdFor(env.organizationId, env.environmentId, baked) }).catch(() => null);
        return { offer, sha: baked, ...(view && !view.runId && view.environmentId === env.environmentId ? { preview: view } : {}) };
    }

    /** POST /runtime/environments/:environmentId/previews: open (or find) the environment's preview at its last bake. */
    async openEnvironment(user: User, environmentId: string): Promise<PreviewView> {
        const { env, settings, baked, offer } = await this.environmentFacts(user, environmentId);
        if (!offer.available || !baked) throw new ConflictException({ code: offer.code ?? 'no_setup', message: offer.reason ?? PREVIEW_REFUSALS_TEXT.noSetup });
        const previewId = environmentPreviewIdFor(env.organizationId, env.environmentId, baked);
        const orgTeam = { organizationId: env.organizationId, teamId: env.teamId };
        const repo = { repositoryId: env.repositoryId, repositoryName: env.repositoryName };
        const view = await this.previews
            .openPreview({
                organizationId: env.organizationId,
                previewId,
                environmentId: env.environmentId,
                repositoryId: env.repositoryId,
                repositoryFullName: env.repositoryName,
                side: 'base',
                sha: baked,
                sealedRepoToken: await this.sealedToken(orgTeam, repo, previewId),
                openedBy: user.uuid!,
                policy: this.policyOf(settings, env, false),
            })
            .catch(fromPort);
        if (view.previewId !== previewId || view.environmentId !== env.environmentId) throw notFound();
        return view;
    }

    /** The preview, if it is the caller's to see: its Run's (or environment's) org and the caller's repo scope on it. */
    private async load(user: User, previewId: string): Promise<{ view: PreviewView }> {
        const organizationId = user.organization?.uuid;
        if (!organizationId || typeof previewId !== 'string' || !PREVIEW_ID_PATTERN.test(previewId)) throw notFound();
        const view = await this.previews.previewStatus({ organizationId, previewId }).catch(fromPort);
        if (view.previewId !== previewId) throw notFound();
        if (view.runId) {
            const run = await this.access.load({ kind: 'user', user }, view.runId, Action.Read, ResourceType.RuntimePreview);
            if (run.repositoryId !== view.repositoryId || run.environmentId !== view.environmentId) throw notFound();
        } else {
            const env = await this.loadEnvironment(user, view.environmentId).catch((e) => {
                if (e instanceof NotFoundException) throw notFound();
                throw e;
            });
            if (env.repositoryId !== view.repositoryId) throw notFound();
        }
        return { view };
    }

    /** GET /runtime/previews/:previewId */
    async get(user: User, previewId: string): Promise<PreviewView> {
        return (await this.load(user, previewId)).view;
    }

    private key(): KeyObject {
        if (this.grantKey) return this.grantKey;
        if (!this.config.previewGrantPrivateKey) {
            throw new HttpException(
                { code: PREVIEW_OFF_CODE, message: 'Previews are off on this deployment: RUNTIME_PREVIEW_GRANT_PRIVATE_KEY is not set.' },
                503,
            );
        }
        try {
            this.grantKey = previewGrantKeyFrom(this.config.previewGrantPrivateKey);
        } catch {
            throw new HttpException(
                { code: PREVIEW_OFF_CODE, message: 'Previews are off on this deployment: RUNTIME_PREVIEW_GRANT_PRIVATE_KEY is not an Ed25519 private key.' },
                503,
            );
        }
        return this.grantKey;
    }

    /**
     * POST /runtime/previews/:previewId/grant: a single-use grant (EdDSA, 60 s,
     * audience the preview host) inside the URL the browser is sent to. The
     * edge exchanges it for its host-only cookie and redirects to `to`.
     */
    async grant(user: User, previewId: string, to: unknown = '/'): Promise<{ redirectUrl: string; expiresAt: string }> {
        const path = to ?? '/';
        if (typeof path !== 'string' || !isPreviewReturnPath(path)) throw new BadRequestException('to must be a path on the preview host');
        const { view } = await this.load(user, previewId);
        if (view.state === 'stopped' || view.state === 'expired') {
            throw new ConflictException(view.reason ?? `This preview is ${view.state}.`);
        }
        const { token, claims } = signPreviewGrant(this.key(), {
            host: view.host,
            userId: user.uuid!,
            organizationId: user.organization!.uuid!,
            previewId: view.previewId,
            side: view.side,
            now: this.now().getTime(),
        });
        // Ids only: the grant is a credential for 60 s and never reaches a log.
        this.logger.log({ msg: 'runtime.preview.grant_issued', organizationId: claims.org, previewId: view.previewId, userId: claims.sub, side: view.side });
        return {
            redirectUrl: `https://${view.host}${this.config.previewPublicPort ? `:${this.config.previewPublicPort}` : ''}${PREVIEW_SESSION_PATH}?grant=${token}&to=${encodeURIComponent(path)}`,
            expiresAt: new Date(claims.exp * 1000).toISOString(),
        };
    }

    /** POST /runtime/previews/:previewId/stop: the opener, or a role that manages previews (owner). */
    async stop(user: User, previewId: string): Promise<PreviewView> {
        const { view } = await this.load(user, previewId);
        if (view.openedBy !== user.uuid) {
            const manages = await this.authorization.check({ user, action: Action.Manage, resource: ResourceType.RuntimePreview });
            if (!manages) throw new ForbiddenException('Only the person who opened this preview, or an owner, can stop it.');
        }
        return this.previews.stopPreview({ organizationId: user.organization!.uuid!, previewId: view.previewId, actor: user.uuid! }).catch(fromPort);
    }
}
