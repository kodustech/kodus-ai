import { z } from 'zod';
import { RecipeValidationNameSchema, RecipeValidationCheckSchema } from '@libs/runtime/contracts/recipe-validation';
import { randomUUID } from 'node:crypto';

import {
    BadRequestException,
    ForbiddenException,
    HttpException,
    Inject,
    Injectable,
    NotFoundException,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { TEAM_CLI_KEY_CAPABILITIES } from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';
import { isRecipePrAction, type RecipePrAction } from '@libs/runtime/blockers/catalog';
import {
    ENV_EXEC_DEFAULT_TIMEOUT_MS,
    ENV_EXEC_MAX_COMMAND,
    ENV_EXEC_MAX_TIMEOUT_MS,
    type EnvSessionOwner,
    type EnvSessionView,
    type EnvSessionWorkspaceRepository,
    type EnvStepView,
    envSessionTokenBinding,
} from '@libs/runtime/contracts/env-session';
import { RepositoryAliasSchema } from '@libs/runtime/contracts/workspace';
import { redactPatterns } from '@libs/runtime/redaction';
import { environmentHealthOf } from '@libs/runtime/environment/environment-health';
import type { EnvironmentHealth } from '@libs/runtime/environment/environment-runtime';

import {
    ENV_AUDIT_MAX_COMMAND,
    ENV_EXEC_QUOTA,
    type EnvAuditRecord,
    type EnvKeyPrincipal,
    EnvSessionPortError,
    envUpCommits,
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_ENV_AUDIT_STORE,
    RUNTIME_ENV_SESSION_PORT,
    RUNTIME_GIT_PORT,
    RUNTIME_LESSON_READER,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_REPO_TOKEN_ISSUER,
    type Clock,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    type RuntimeApiConfig,
    type RuntimeEnvAuditStore,
    type RuntimeEnvSessionPort,
    type RuntimeGitPort,
    type RuntimeLessonReader,
    type RuntimeRepoTokenIssuer,
} from '../domain/ports';
import { membersOr, RuntimeEnvironmentMembers } from './environment-members.service';
import { RuntimeSetupRequester } from './runtime-setup-requester.service';
import { sealForRuntime } from './secret-sealer';
import { ApplyBlockerFixUseCase, KODY_FIX_ORIGIN, KODY_FIX_PREFIX } from './use-cases/apply-blocker-fix.use-case';
import { blockerGroups, EnvironmentViewBuilder, memoryFor, type RuntimeBlockerGroupView } from './use-cases/environments.use-cases';

// The /mcp/env tools (§4 "MCP e CLI", §7, Inc. 1). Only a team key reaches
// here, never a user or the service credential (S-45). Every call checks the
// exact capability, then loads the object and checks org, team and the key's
// repo list on it: anything outside answers 404 and nothing reaches the cell
// (S-46). env_exec is quota-limited per key and per org and every call is
// audited (S-27).

const RECIPE_PATH = '.kodus/workspace.yaml';
const EnvValidateInputSchema = z.strictObject({
    sessionId: z.string().min(1).max(128),
    name: RecipeValidationNameSchema,
    timeoutMs: z.number().int().min(1000).max(ENV_EXEC_MAX_TIMEOUT_MS).optional(),
});

export interface EnvTarget {
    environmentId?: unknown;
    repositoryId?: unknown;
}

export interface EnvBlockersView {
    environment: { environmentId: string; repositoryId: string; repositoryName: string; state: string };
    blockers: RuntimeBlockerGroupView[];
}

export type EnvFixResult = { action: 'retry_setup'; setupRequested: true } | { action: RecipePrAction; pullRequest: { number: number; url: string } };

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const notFound = (what = 'Environment') => new NotFoundException(`${what} not found`);

/** The worker's refusal as an HTTP error of the product (its message is ours, written for the dev). */
function fromPort(e: unknown): never {
    if (e instanceof EnvSessionPortError) {
        if (e.status === 404) throw notFound('Session');
        throw new HttpException({ code: e.code, message: e.message }, e.status);
    }
    throw e;
}

@Injectable()
export class RuntimeEnvToolsService {
    private readonly logger = createLogger(RuntimeEnvToolsService.name);

    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly products: Pick<ProductEnvironmentStore, 'get' | 'findByRepository' | 'listByOrganization'>,
        private readonly views: EnvironmentViewBuilder,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: Pick<RuntimeGitPort, 'getDefaultBranchHead'>,
        @Inject(RUNTIME_REPO_TOKEN_ISSUER)
        private readonly repoTokens: RuntimeRepoTokenIssuer,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: Pick<RuntimeApiConfig, 'secretSealKey'>,
        @Inject(RUNTIME_ENV_SESSION_PORT)
        private readonly sessions: RuntimeEnvSessionPort,
        @Inject(RUNTIME_ENV_AUDIT_STORE)
        private readonly audit: RuntimeEnvAuditStore,
        // Concrete classes, not Pick<>: Nest injects by the runtime type, and a Pick erases to Object.
        private readonly setups: RuntimeSetupRequester,
        private readonly applyFix: ApplyBlockerFixUseCase,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        @Optional() @Inject(RUNTIME_LESSON_READER) private readonly lessons?: RuntimeLessonReader,
        // Required by Nest; made without it (the older tests), an environment is its primary repository alone.
        @Inject(RuntimeEnvironmentMembers)
        private readonly members?: RuntimeEnvironmentMembers,
    ) {}

    /** The key reaches an environment only when its repository list holds every repository of it: the machine holds all their code. */
    private async covers(p: EnvKeyPrincipal, env: ProductEnvironment): Promise<boolean> {
        if (env.organizationId !== p.organizationId || env.teamId !== p.teamId) return false;
        const ids = await membersOr(this.members, this.products).repositoryIds(env);
        return ids.every((id) => p.repositoryIds.includes(id));
    }

    /** The call's own error still answers it; the audit row keeps its first outcome, so the loss is logged. */
    private auditOutcomeLost(organizationId: string, auditId: string, tool: string, error: unknown) {
        this.logger.warn({
            message: 'Runtime env tools: the outcome of a failed call was not written to its audit row',
            context: RuntimeEnvToolsService.name,
            error: error instanceof Error ? error : undefined,
            metadata: { organizationId, auditId, tool },
        });
    }

    /** Exact equality, no wildcard (mcp-tool-authorizer.service.ts). */
    private require(p: EnvKeyPrincipal, ...anyOf: string[]) {
        if (!anyOf.some((c) => p.capabilities.includes(c))) {
            throw new ForbiddenException(`This team key does not have the ${anyOf.join(' or ')} capability`);
        }
    }

    private owner(p: EnvKeyPrincipal): EnvSessionOwner {
        return { organizationId: p.organizationId, teamId: p.teamId, keyId: p.keyId, repositoryIds: [...p.repositoryIds] };
    }

    /** The environments this key reaches: its team's, in its repos. */
    async reachable(p: EnvKeyPrincipal): Promise<ProductEnvironment[]> {
        const all = await this.products.listByOrganization(p.organizationId);
        const out: ProductEnvironment[] = [];
        for (const e of all) if (await this.covers(p, e)) out.push(e);
        return out;
    }

    /** By environmentId, by repositoryId, or the key's only one; anything outside the key is 404. */
    async resolve(p: EnvKeyPrincipal, target: EnvTarget): Promise<ProductEnvironment> {
        let env: ProductEnvironment | null;
        if (target.environmentId !== undefined && target.environmentId !== null && target.environmentId !== '') {
            env = isId(target.environmentId) ? await this.products.get(p.organizationId, target.environmentId) : null;
        } else if (target.repositoryId !== undefined && target.repositoryId !== null && target.repositoryId !== '') {
            // Every environment the repository is part of that the key reaches; several must be named.
            const found = isId(target.repositoryId) ? await membersOr(this.members, this.products).environmentsOf(p.organizationId, target.repositoryId) : [];
            const mine: ProductEnvironment[] = [];
            for (const m of found) if (await this.covers(p, m.env)) mine.push(m.env);
            if (mine.length > 1) {
                throw new BadRequestException(`The repository is part of several environments; name one: ${mine.map((e) => `${e.environmentId} (${e.repositoryName})`).join(', ')}`);
            }
            env = mine[0] ?? null;
        } else {
            const mine = await this.reachable(p);
            if (mine.length === 1) return mine[0];
            throw new BadRequestException(
                mine.length
                    ? `Name the environment: ${mine.map((e) => `${e.environmentId} (${e.repositoryName})`).join(', ')}`
                    : 'This key reaches no Kody Runtime environment. Add its repository to the key and set the environment up first.',
            );
        }
        if (!env || !(await this.covers(p, env))) throw notFound();
        return env;
    }

    /**
     * env_up: a session on the environment at a commit (the default branch head by default), or its blockers.
     * A multi-repository environment boots whole, like a setup: every repository at its default-branch head
     * or at the commit `commits` names for its alias, each with a download token for that repository only,
     * sealed to the session.
     */
    async up(p: EnvKeyPrincipal, input: EnvTarget & { sha?: unknown; sessionId?: unknown; commits?: unknown }): Promise<EnvSessionView> {
        this.require(p, TEAM_CLI_KEY_CAPABILITIES.ENV_EXEC);
        // Asking again with the sessionId is how the agent waits for `acquiring` to settle.
        if (input.sessionId !== undefined) {
            if (!isId(input.sessionId)) throw notFound('Session');
            return this.checked(p, await this.sessions.status(this.owner(p), input.sessionId).catch(fromPort));
        }
        const env = await this.resolve(p, input);
        const all = await membersOr(this.members, this.products).list(env);
        const primaryAlias = all[0].alias;
        const named = envUpCommits(input, all.map((r) => r.alias), primaryAlias);
        if ('error' in named) throw new BadRequestException(named.error);
        const multi = all.length > 1;
        const orgTeam = { organizationId: env.organizationId, teamId: env.teamId };
        const headOf = async (repo: { repositoryId: string; repositoryName: string }, which: string) => {
            const head = await this.git.getDefaultBranchHead({ ...orgTeam, ...repo }).catch(() => {
                throw new ServiceUnavailableException(`Kodus could not read the default branch of ${which}. Try again.`);
            });
            if (head.status !== 'ok') throw new ServiceUnavailableException(`Kodus cannot read the default branch of ${which}.`);
            return head.sha;
        };
        const tokenOf = async (repo: { repositoryId: string; repositoryName: string }, which: string) => {
            try {
                return await this.repoTokens.issue({ ...orgTeam, ...repo });
            } catch {
                throw new ServiceUnavailableException(`Kodus could not issue the download token for ${which}.`);
            }
        };
        const repo = { repositoryId: env.repositoryId, repositoryName: env.repositoryName };
        const sha = named.commits.get(primaryAlias) ?? (await headOf(repo, 'this repository'));
        const sessionId = randomUUID();
        const binding = envSessionTokenBinding(sessionId);
        const sealedRepoToken = sealForRuntime(this.config, await tokenOf(repo, 'this repository'), binding);
        const workspace: EnvSessionWorkspaceRepository[] = [];
        if (multi) {
            for (const m of all) {
                const common = { repositoryId: m.repositoryId, fullName: m.fullName, alias: m.alias, role: m.role };
                if (m.role === 'primary') {
                    workspace.push({ ...common, sha, sealedRepoToken });
                    continue;
                }
                const member = { repositoryId: m.repositoryId, repositoryName: m.repositoryName };
                const memberSha = named.commits.get(m.alias) ?? (await headOf(member, m.fullName));
                workspace.push({ ...common, sha: memberSha, sealedRepoToken: sealForRuntime(this.config, await tokenOf(member, m.fullName), binding) });
            }
        }
        const view = await this.sessions
            .open({
                ...this.owner(p),
                repositoryId: env.repositoryId,
                environmentId: env.environmentId,
                sessionId,
                sha,
                repositoryFullName: env.repositoryName,
                sealedRepoToken,
                correlationId: `mcp:${sessionId}`,
                ...(multi ? { workspace } : {}),
            })
            .catch(fromPort);
        return this.checked(p, view);
    }

    /** What the worker returned must still be this key's (defense in depth over the worker's own check). */
    private checked<T extends { repositoryId: string }>(p: EnvKeyPrincipal, view: T): T {
        if (!p.repositoryIds.includes(view.repositoryId)) throw notFound('Session');
        return view;
    }

    /** env_exec: quota, audit, then the command goes to the session's claim; answers the stepId at once. */
    async exec(
        p: EnvKeyPrincipal,
        input: { sessionId?: unknown; command?: unknown; cwd?: unknown; timeoutMs?: unknown; repository?: unknown },
    ): Promise<EnvStepView> {
        return this.execute(p, input);
    }

    /** Explicit base-recipe check: shell output is internal evidence, never a verdict. */
    async validate(p: EnvKeyPrincipal, input: { sessionId?: unknown; name?: unknown; timeoutMs?: unknown }): Promise<EnvStepView> {
        this.require(p, TEAM_CLI_KEY_CAPABILITIES.ENV_EXEC);
        const parsed = EnvValidateInputSchema.safeParse(input);
        if (!parsed.success) throw new BadRequestException('Name a pinned validation and session; executable arguments are not accepted.');
        const resolved = await this.sessions.validation(this.owner(p), parsed.data.sessionId, parsed.data.name).catch(fromPort);
        this.checked(p, resolved.session);
        if (
            resolved.name !== parsed.data.name ||
            resolved.session.sessionId !== parsed.data.sessionId ||
            !RecipeValidationCheckSchema.safeParse({ name: resolved.name, run: resolved.command }).success
        )
            throw new ServiceUnavailableException('The Runtime returned an invalid validation.');
        return this.execute(
            p,
            {
                sessionId: parsed.data.sessionId,
                command: resolved.command,
                ...(parsed.data.timeoutMs !== undefined ? { timeoutMs: parsed.data.timeoutMs } : {}),
            },
            { validationName: parsed.data.name, executionScope: 'workload' },
        );
    }
    private async execute(
        p: EnvKeyPrincipal,
        input: { sessionId?: unknown; command?: unknown; cwd?: unknown; timeoutMs?: unknown; repository?: unknown },
        validation?: { validationName: string; executionScope: 'workload' },
    ): Promise<EnvStepView> {
        this.require(p, TEAM_CLI_KEY_CAPABILITIES.ENV_EXEC);
        if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > ENV_EXEC_MAX_COMMAND) {
            throw new BadRequestException(`command must be a non-empty string of at most ${ENV_EXEC_MAX_COMMAND} characters`);
        }
        if (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.length > 1_024)) throw new BadRequestException('cwd must be a path');
        if (input.repository !== undefined && !RepositoryAliasSchema.safeParse(input.repository).success) {
            throw new BadRequestException('repository is the alias of a repository of the environment');
        }
        const timeoutMs = input.timeoutMs === undefined ? ENV_EXEC_DEFAULT_TIMEOUT_MS : input.timeoutMs;
        if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > ENV_EXEC_MAX_TIMEOUT_MS) {
            throw new BadRequestException(`timeoutMs must be between 1000 and ${ENV_EXEC_MAX_TIMEOUT_MS}`);
        }
        if (!isId(input.sessionId)) throw notFound('Session');
        const owner = this.owner(p);
        const session = this.checked(p, await this.sessions.status(owner, input.sessionId).catch(fromPort));

        const stepId = randomUUID();
        const at = this.now();
        const record: EnvAuditRecord = {
            auditId: randomUUID(),
            kind: 'env_exec',
            organizationId: p.organizationId,
            teamId: p.teamId,
            keyId: p.keyId,
            repositoryId: session.repositoryId,
            environmentId: session.environmentId,
            sessionId: session.sessionId,
            stepId,
            command: redactPatterns(input.command).text.slice(0, ENV_AUDIT_MAX_COMMAND),
            at: at.toISOString(),
            outcome: 'accepted',
        };
        // Recorded first, counted after: two calls at the limit may both be refused, never both pass.
        await this.audit.record(record);
        const since = new Date(at.getTime() - ENV_EXEC_QUOTA.windowMs).toISOString();
        const [byKey, byOrg] = await Promise.all([
            this.audit.countAccepted({ organizationId: p.organizationId, keyId: p.keyId, since }),
            this.audit.countAccepted({ organizationId: p.organizationId, since }),
        ]);
        if (byKey > ENV_EXEC_QUOTA.perKeyPerHour || byOrg > ENV_EXEC_QUOTA.perOrgPerHour) {
            const which = byKey > ENV_EXEC_QUOTA.perKeyPerHour ? `${ENV_EXEC_QUOTA.perKeyPerHour} per key` : `${ENV_EXEC_QUOTA.perOrgPerHour} per organization`;
            await this.audit.setOutcome(p.organizationId, record.auditId, 'refused_quota', which);
            throw new HttpException({ code: 'env_exec_quota', message: `env_exec is limited to ${which} per hour. Try again later.` }, 429);
        }
        try {
            return await this.sessions.exec(owner, session.sessionId, {
                stepId,
                command: input.command,
                ...(input.cwd ? { cwd: input.cwd as string } : {}),
                ...(input.repository !== undefined ? { repository: input.repository as string } : {}),
                timeoutMs,
                ...validation,
            });
        } catch (e) {
            await this.audit
                .setOutcome(
                    p.organizationId,
                    record.auditId,
                    e instanceof EnvSessionPortError ? 'refused' : 'failed',
                    e instanceof EnvSessionPortError ? e.code : 'unavailable',
                )
                .catch((error: unknown) => this.auditOutcomeLost(p.organizationId, record.auditId, 'env_exec', error));
            return fromPort(e);
        }
    }

    /** env_step: a step's result, when it is ready. */
    async step(p: EnvKeyPrincipal, input: { stepId?: unknown }): Promise<EnvStepView> {
        this.require(p, TEAM_CLI_KEY_CAPABILITIES.ENV_EXEC);
        if (!isId(input.stepId)) throw notFound('Step');
        return this.sessions.step(this.owner(p), input.stepId).catch(fromPort);
    }

    /** env_down: release the session's claim. */
    async down(p: EnvKeyPrincipal, input: { sessionId?: unknown }): Promise<EnvSessionView> {
        this.require(p, TEAM_CLI_KEY_CAPABILITIES.ENV_EXEC);
        if (!isId(input.sessionId)) throw notFound('Session');
        return this.checked(p, await this.sessions.release(this.owner(p), input.sessionId).catch(fromPort));
    }

    private async groups(env: ProductEnvironment) {
        const [setup, runs] = await Promise.all([
            this.views.setup(env.organizationId, env.environmentId),
            this.views.environmentRuns(env.organizationId, env.environmentId),
        ]);
        const mine = runs.filter((r) => r.organizationId === env.organizationId && r.environmentId === env.environmentId);
        return { setup, groups: blockerGroups(setup, mine, await memoryFor(this.lessons, env)) };
    }

    /** env_blockers: the environment's blockers with evidence and the catalog's fixes (the same read as the Runtime page). */
    async blockers(p: EnvKeyPrincipal, target: EnvTarget): Promise<EnvBlockersView> {
        this.require(p, TEAM_CLI_KEY_CAPABILITIES.ENV_EXEC, TEAM_CLI_KEY_CAPABILITIES.ENV_FIX);
        const env = await this.resolve(p, target);
        const { setup, groups } = await this.groups(env);
        return {
            environment: {
                environmentId: env.environmentId,
                repositoryId: env.repositoryId,
                repositoryName: env.repositoryName,
                state: setup?.state ?? env.state,
            },
            blockers: groups.map(({ recipeChanges: _, ...view }) => view),
        };
    }

    /**
     * env_status: the environment's health (EnvironmentHealth, docs §5): state, the week's setup boots,
     * time to ready, image, cell and blockers by signature. Read from the setup record the Runtime keeps
     * (runtime_environment_setups, read-only and org-scoped), never a cell. A record of another org or
     * another environment reads as never set up.
     */
    async status(p: EnvKeyPrincipal, target: EnvTarget): Promise<EnvironmentHealth> {
        this.require(p, TEAM_CLI_KEY_CAPABILITIES.ENV_EXEC, TEAM_CLI_KEY_CAPABILITIES.ENV_FIX);
        const env = await this.resolve(p, target);
        const rec = await this.views.setup(env.organizationId, env.environmentId);
        const ours = rec && rec.organizationId === env.organizationId && rec.environmentId === env.environmentId ? rec : null;
        return environmentHealthOf(ours ?? { environmentId: env.environmentId }, this.now());
    }

    /**
     * env_fix: one fix the catalog offers for that blocker, read again here.
     * A recipe fix opens a PR a human merges; "set up again" asks for a setup.
     * Approving an egress host stays with an org admin on the Runtime page: a
     * key never widens egress (S-27, S-40). Never free text into the recipe.
     */
    async fix(p: EnvKeyPrincipal, input: EnvTarget & { signature?: unknown; fixId?: unknown }): Promise<EnvFixResult> {
        this.require(p, TEAM_CLI_KEY_CAPABILITIES.ENV_FIX);
        if (typeof input.signature !== 'string' || input.signature.length > 512 || typeof input.fixId !== 'string' || input.fixId.length > 300)
            throw notFound('Fix');
        const env = await this.resolve(p, input);
        const { setup, groups } = await this.groups(env);
        const group = groups.find((g) => g.signature === input.signature);
        const fix = group?.fixes.find((f) => f.id === input.fixId);
        if (!group || !fix) throw notFound('Fix');
        if (fix.action === 'approve_host') {
            throw new ForbiddenException('Approving an egress host is for an org admin on the Kody Runtime page; a team key never widens egress.');
        }

        const record: EnvAuditRecord = {
            auditId: randomUUID(),
            kind: 'env_fix',
            organizationId: p.organizationId,
            teamId: p.teamId,
            keyId: p.keyId,
            repositoryId: env.repositoryId,
            environmentId: env.environmentId,
            command: `${fix.id} (${group.signature})`.slice(0, ENV_AUDIT_MAX_COMMAND),
            at: this.now().toISOString(),
            outcome: 'accepted',
        };
        await this.audit.record(record);
        try {
            if (fix.action === 'retry_setup') {
                await this.setups.request(env, { uuid: `team-key:${p.keyId}` });
                return { action: 'retry_setup', setupRequested: true };
            }
            const change = group.recipeChanges.get(fix.id);
            if (isRecipePrAction(fix.action) && change && fix.recipeDiff) {
                const pullRequest = await this.applyFix.openRecipePullRequest(
                    env,
                    setup?.recipe?.path ?? RECIPE_PATH,
                    fix.id,
                    fix.label,
                    change,
                    fix.id.startsWith(KODY_FIX_PREFIX) ? KODY_FIX_ORIGIN : undefined,
                );
                return { action: fix.action, pullRequest };
            }
            throw new BadRequestException('This fix is made by hand in the repository; Kodus has nothing to apply.');
        } catch (e) {
            await this.audit
                .setOutcome(p.organizationId, record.auditId, 'failed', e instanceof HttpException ? String(e.getStatus()) : 'error')
                .catch((error: unknown) => this.auditOutcomeLost(p.organizationId, record.auditId, 'env_fix', error));
            throw e;
        }
    }
}
