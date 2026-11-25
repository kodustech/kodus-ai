import { RECIPE_AUTHOR_VERSION, recipeAuthorRevision } from '@libs/runtime/run/recipe-author-version';
import { randomUUID } from 'crypto';

import { insertionOrderJson, nulJoinedHex, sha256Hex } from '@libs/runtime/contracts/derive-id';

import {
    BadGatewayException,
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    NotFoundException,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';

import type { AgentRunner } from '@libs/agent-harness/domain/contracts/agent.contract';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import { createLogger } from '@libs/core/log/logger';
import {
    RECIPE_AUTHOR_FIRST_ATTEMPT,
    RECIPE_AUTHOR_REFUSAL,
    type RecipeAuthorRequest,
    RecipeAuthorRequestSchema,
    type RecipeAuthorResponse,
} from '@libs/runtime/contracts/recipe-author';
import { RUNTIME_RECIPE_MAX_BYTES } from '@libs/runtime/contracts/runtime-commands';
import { parseRecipe } from '@libs/runtime/protocol/recipe';
import { redactPatterns } from '@libs/runtime/redaction';
import { setupLearnScopeId } from '@libs/runtime/run';

import { decideBudget, setupBudgetLimits, startOfUtcDay, tightestBudgetScope, withOrgBudget } from '../../domain/budget';
import {
    LlmBudgetBusyError,
    RUNTIME_AGENT_RUNNER_FACTORY,
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_EGRESS_READER,
    RUNTIME_LLM_USAGE_STORE,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_SETTINGS_STORE,
    type Clock,
    type EnvironmentRepository,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    type RuntimeAgentRunnerFactory,
    type RuntimeApiConfig,
    type RuntimeEgressReader,
    type RuntimeEnvironmentSetupReader,
    type RuntimeGitPort,
    type RuntimeLlmUsageStore,
    type RuntimeSettingsStore,
} from '../../domain/ports';
import type { SetupTokenClaims } from '../../domain/run-token';
import { RUNTIME_RECIPE_AUTHOR_RECEIPTS, type RecipeAuthorOutcome, type RecipeAuthorReceipts, type RecipeAuthorReservation } from '../../domain/setup-calls';
import { openSetupToken } from '../setup-token';
import { type AuthoredFile, checkAuthoredSubmission } from '../recipe-author/authored-files-policy';
import { GitRepoReader } from '../recipe-author/git-repo-reader';
import { PULL_REQUEST_FOCUS_LIMITS, type PullRequestPaths } from '../recipe-author/pull-request-focus';
import {
    authorRecipe,
    AUTHOR_INSTRUCTIONS_CHANGED,
    type PreviousAttempt,
    RECIPE_AUTHOR_LIMITS,
    recipeAuthorWorkspace,
    type RecipeAuthorWorkspace,
    type RecipeAuthorWorkspaceRepository,
    withoutSuiteBlock,
} from '../recipe-author/recipe-author.agent';
import { RuntimeEnvironmentMembers } from '../environment-members.service';
import { withFailureContext } from '../failure-context';
import { directoryExistsCheck, fileExists, READ_LIMITS, type RepoReader, RepoPathError } from '../recipe-author/repo-reader';

/** The task the setup's budget counts the author's tokens under. */
export const RECIPE_AUTHOR_TASK = 'runtime.recipe_author';
/** Tokens the setup's budget must still have for a run to start: below it the agent could not read and submit. */
export const RECIPE_AUTHOR_MIN_TOKENS = 20_000;
/** The signature a reused recipe's earlier attempt carries when the checks refuse it at the new commit. */
export const REUSED_RECIPE_REFUSED = 'authored_checks';
/** What Kodus rewrote that the answer says, at most. */
const ADJUSTED_MAX = 20;
const adjustedOf = (lines: readonly string[] | undefined) => (lines?.length ? { adjusted: lines.slice(0, ADJUSTED_MAX).map((l) => l.slice(0, 300)) } : {});
/** Model text, which the repository could steer: redacted like the prompt (S-51), cut, shown as text only. */
const said = (text: string, max: number) => redactPatterns(text).text.slice(0, max);

/**
 * The whole run, model calls and Git reads, stops here. Measured on ten real
 * repositories (deepseek-v4-pro, 6 to 16 steps): 111 to 360 s, three of them
 * past five minutes, which a five-minute limit turned into "the model call
 * failed" with no recipe.
 */
export const RECIPE_AUTHOR_TIMEOUT_MS = 10 * 60_000;
/** How long the open pull requests' paths may take before the author runs without them. */
export const OPEN_PULL_REQUESTS_TIMEOUT_MS = 20_000;
/**
 * How long a call holds its attempt: the run's own ceiling and a margin. A
 * call still holding it past this died with its API instance, and the next
 * one asking runs the attempt again.
 */
export const RECIPE_AUTHOR_LEASE_MS = RECIPE_AUTHOR_TIMEOUT_MS + 2 * 60_000;

/** The receipt of the attempt this call runs: `spent` once the budget holds a reservation for it. */
interface AttemptLedger {
    key: string;
    owner: string;
    spent: boolean;
    reservation?: RecipeAuthorReservation;
}

/** What the worker reads on a 502: the model or the run failed, which is no verdict of Kody's on the repository. */
export const RECIPE_AUTHOR_UNAVAILABLE = { code: 'llm_unavailable', message: "Kody's model call failed" } as const;
/** The same 502 when the Git platform failed while the checks read the commit: the worker reads it as no answer, never as Kody's no_recipe. */
export const RECIPE_AUTHOR_GIT_UNAVAILABLE = { code: 'llm_unavailable', message: 'the Git platform failed while Kodus checked the recipe' } as const;

/**
 * The runner of one author run, keeping the state it ended in: the agent's
 * result says no_recipe whether Kody found nothing or the model failed, and
 * only the first is Kody's verdict.
 */
class ObservedRunner implements AgentRunner {
    last?: RunState;

    constructor(private readonly inner: AgentRunner) {}

    async run(...args: Parameters<AgentRunner['run']>): Promise<RunState> {
        this.last = await this.inner.run(...args);
        return this.last;
    }
}

const counted = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : undefined);

/** The receipt key of one (setupKey, attempt) of the recipe author: stored, so a resumed setup finds its call. */
export const recipeAuthorCallKey = (organizationId: string, setupKey: string, attempt: number | string) =>
    nulJoinedHex(['recipe-author', organizationId, setupKey, attempt]);

/** What a recipe author request asked: the same key asked with another fingerprint is another request. */
export const recipeAuthorFingerprint = (body: Pick<RecipeAuthorRequest, 'sha' | 'last' | 'reauthor'>) =>
    sha256Hex(insertionOrderJson({ sha: body.sha, last: body.last ?? null, ...(body.reauthor ? { reauthor: body.reauthor } : {}) }));

/**
 * POST /internal/runtime/recipe-author (docs RECIPE-AGENT-TEST-PLAN, "Ligar ao
 * produto"). The setup's recipe step found no recipe on the default branch and
 * no inferred one; with the setup token, it asks the product to have Kody
 * write it. The agent runs here, on the org's LLM_TASK.runtime slot, and the
 * key never reaches the worker or the cell (ADR-057). It only reads the
 * commit the setup records, through the Git integration; what it submits
 * passes the authored-recipe checks (parseRecipe plus the rules for a recipe
 * Kody wrote) before it is returned, and the cell checks it again like any
 * recipe. Its tokens count against the setup's LLM budget, under the same
 * scope id as the setup's learn loop (S-47): reserved before the run, settled
 * with what the model reported.
 */
@Injectable()
export class RuntimeRecipeAuthorUseCase {
    private readonly logger = createLogger(RuntimeRecipeAuthorUseCase.name);

    constructor(
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        @Inject(RUNTIME_LLM_USAGE_STORE)
        private readonly usage: RuntimeLlmUsageStore,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: RuntimeGitPort,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly products: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(RUNTIME_AGENT_RUNNER_FACTORY)
        private readonly runners: RuntimeAgentRunnerFactory,
        @Optional()
        @Inject(RUNTIME_ENVIRONMENT_SETUP_READER)
        private readonly setups?: RuntimeEnvironmentSetupReader,
        @Optional()
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings?: Pick<RuntimeSettingsStore, 'getOrganization'>,
        // Required by Nest; made without it (the older tests), Kody writes the recipe of one repository.
        @Inject(RuntimeEnvironmentMembers)
        private readonly members?: RuntimeEnvironmentMembers,
        // Absent (the older tests, a deployment without the product store): every call runs, as before.
        @Optional()
        @Inject(RUNTIME_RECIPE_AUTHOR_RECEIPTS)
        private readonly receipts?: RecipeAuthorReceipts,
        // The org's Outbound access switch: Google Fonts reaches a build only through the recommended list.
        @Optional()
        @Inject(RUNTIME_EGRESS_READER)
        private readonly egress?: Pick<RuntimeEgressReader, 'settings'>,
    ) {}

    /**
     * The repositories the author reads beside the primary: the environment's
     * members (membership), each at the commit this setup boots it at (the
     * setup record's workspace), the primary at the setup's sha. Undefined for
     * one repository, or for a setup that boots the primary alone (one asked
     * for before the members were added): the author writes for what boots.
     */
    private async workspaceOf(
        product: ProductEnvironment,
        setup: { sha: string; workspace?: Array<{ repositoryId: string; sha: string }> },
    ): Promise<{ list: RecipeAuthorWorkspaceRepository[]; byId: Map<string, EnvironmentRepository> } | undefined> {
        if (!this.members) return undefined;
        const members = await this.members.list(product);
        if (members.length <= 1 || !setup.workspace?.length) return undefined;
        const shaOf = new Map(setup.workspace.map((r) => [r.repositoryId, r.sha]));
        const list: RecipeAuthorWorkspaceRepository[] = [];
        for (const m of members) {
            const sha = m.role === 'primary' ? setup.sha : shaOf.get(m.repositoryId);
            if (!sha) continue;
            list.push({ repositoryId: m.repositoryId, fullName: m.fullName, alias: m.alias, role: m.role, sha });
        }
        if (list.length <= 1) return undefined;
        return { list, byId: new Map(members.map((m) => [m.repositoryId, m])) };
    }

    /**
     * `signal`: the caller went away (the worker's request closed). The run
     * stops with it instead of spending the setup's budget on an answer
     * nobody reads; the 5-minute ceiling stands either way.
     */
    /**
     * The changed paths of the repository's open pull requests, the most
     * recently updated first, for the author's Facts (pull-request-focus.ts).
     * A hint only: a platform with no listing, a failed call or a slow Git API
     * leaves it empty and the author runs as before.
     */
    private async openPullRequestPaths(repo: { organizationId: string; teamId: string; repositoryId: string; repositoryName: string }): Promise<PullRequestPaths[]> {
        if (!this.git.listOpenPullRequests) return [];
        const read = async (): Promise<PullRequestPaths[]> => {
            const listed = await this.git.listOpenPullRequests!(repo);
            if (listed === 'unsupported_platform') return [];
            const recent = [...listed].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, PULL_REQUEST_FOCUS_LIMITS.pullRequests);
            const diffs = await Promise.allSettled(recent.map((pr) => this.git.getPullRequestDiff({ ...repo, prNumber: pr.number, headSha: pr.headSha })));
            return diffs.flatMap((d, i) => (d.status === 'fulfilled' ? [{ number: recent[i].number, paths: d.value.files.map((f) => f.path) }] : []));
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<PullRequestPaths[]>((resolve) => {
            timer = setTimeout(() => resolve([]), OPEN_PULL_REQUESTS_TIMEOUT_MS);
        });
        try {
            return await Promise.race([read().catch(() => [] as PullRequestPaths[]), late]);
        } finally {
            clearTimeout(timer);
        }
    }

    async execute(input: { authorization?: string; body: unknown; signal?: AbortSignal }): Promise<RecipeAuthorResponse> {
        // Only a setup token: a Run token never asks for a recipe.
        const claims = openSetupToken(this.config, input.authorization, this.now(), 'recipe author');

        const parsed = RecipeAuthorRequestSchema.safeParse(input.body);
        if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));

        // The setup the token names: the environment's latest, still running, booting the commit the request names.
        if (!this.setups) throw new ServiceUnavailableException('Runtime recipe author is not configured for setups');
        const setup = await this.setups.get(claims.organizationId, claims.environmentId);
        if (!setup || setup.organizationId !== claims.organizationId || setup.environmentId !== claims.environmentId) {
            throw new NotFoundException('Setup not found');
        }
        if (setup.key !== claims.setupKey || setup.repositoryId !== claims.repositoryId) {
            throw new ConflictException('A newer setup of this environment replaced this one');
        }
        if (setup.state !== 'setting_up') throw new ConflictException('This setup has finished');
        // Kody writes only from the default-branch head the product resolved (§6), never a dev override.
        if (setup.refSource !== 'default_branch' || !setup.sha) throw new ForbiddenException('Kody writes a recipe only for the default branch head');
        if (setup.sha !== parsed.data.sha) throw new ForbiddenException('The setup boots another commit');

        const product = await this.products.get(claims.organizationId, claims.environmentId);
        if (!product || product.organizationId !== claims.organizationId || product.repositoryId !== claims.repositoryId) {
            throw new NotFoundException('Environment not found');
        }

        // Each (setupKey, attempt) is answered once (RecipeAuthorAttemptSchema): asked again, its answer, with no new run or budget.
        const remembered = await this.remembered(claims, parsed.data);
        if ('outcome' in remembered) {
            if (remembered.outcome.status === 200) return remembered.outcome.body as RecipeAuthorResponse;
            throw new HttpException(remembered.outcome.body as Record<string, unknown>, remembered.outcome.status);
        }
        const ledger = remembered.ledger;
        if (!ledger) return this.write(claims, parsed.data, { ...setup, sha: setup.sha }, product, undefined, input.signal);
        try {
            // The run is the attempt's, not the caller's: one that leaves (a timeout, a worker restart) asks again for its answer.
            const answer = await this.write(claims, parsed.data, { ...setup, sha: setup.sha }, product, ledger, undefined);
            await this.remember(ledger, { status: 200, body: answer });
            return answer;
        } catch (e) {
            // A refusal after the budget was spent is the attempt's answer; one before it (no LLM, no budget, the Git platform) is asked again.
            if (e instanceof HttpException && ledger.spent) await this.remember(ledger, { status: e.getStatus(), body: e.getResponse() });
            else await this.receipts!.release(ledger.key, ledger.owner).catch((err: unknown) => this.warnReceipts('release', claims, err));
            throw e;
        }
    }

    /**
     * Where this (setupKey, attempt) is. Without receipts (a deployment or a
     * test with none) every call runs, as before. A request with no attempt
     * (a worker that predates it) is `author-0`; asked again with another
     * body it is that worker's next repair, run unrecorded as before.
     */
    private async remembered(
        claims: SetupTokenClaims,
        body: RecipeAuthorRequest,
    ): Promise<{ outcome: RecipeAuthorOutcome } | { ledger?: AttemptLedger }> {
        if (!this.receipts) return {};
        const attempt = body.attempt ?? RECIPE_AUTHOR_FIRST_ATTEMPT;
        const key = recipeAuthorCallKey(claims.organizationId, claims.setupKey, attempt);
        const fingerprint = recipeAuthorFingerprint(body);
        const owner = randomUUID();
        const now = this.now();
        const leaseUntil = new Date(now.getTime() + RECIPE_AUTHOR_LEASE_MS);
        const expiresAt = new Date(Math.max(claims.exp * 1000, leaseUntil.getTime()));
        const claim = await this.receipts.claim({ key, fingerprint, owner, now, leaseUntil, expiresAt }).catch((e: unknown) => {
            // No code: the worker asks again with the same attempt. Logged once, by the API's exception filter.
            throw withFailureContext(
                new ServiceUnavailableException('Kodus could not read whether this attempt ran; ask again'),
                { organizationId: claims.organizationId, environmentId: claims.environmentId, failure: 'receipts_claim' },
                e,
            );
        });
        const meta = { organizationId: claims.organizationId, environmentId: claims.environmentId, attempt };
        switch (claim.state) {
            case 'fresh':
                return { ledger: { key, owner, spent: false } };
            case 'taken_over':
                // The call that held it stopped answering past its lease (the API restarted mid-run): this one runs it, on what that one reserved.
                this.logger.warn({ message: 'Runtime recipe author: an attempt whose run was lost runs again', context: RuntimeRecipeAuthorUseCase.name, metadata: { ...meta, reusedReservation: !!claim.reservation } });
                return { ledger: { key, owner, spent: !!claim.reservation, ...(claim.reservation ? { reservation: claim.reservation } : {}) } };
            case 'running':
                throw new HttpException(
                    { statusCode: HttpStatus.CONFLICT, code: RECIPE_AUTHOR_REFUSAL.inProgress, message: 'Kody is still writing this attempt; ask again later' },
                    HttpStatus.CONFLICT,
                );
            case 'done':
                this.logger.log({ message: 'Runtime recipe author: an attempt asked again, answered from its receipt', context: RuntimeRecipeAuthorUseCase.name, metadata: meta });
                return { outcome: claim.outcome };
            case 'conflict':
                if (!body.attempt) return {};
                throw new HttpException(
                    { statusCode: HttpStatus.CONFLICT, code: RECIPE_AUTHOR_REFUSAL.conflict, message: 'This attempt was asked before with another request' },
                    HttpStatus.CONFLICT,
                );
        }
    }

    /** Records the attempt's answer; a store that fails loses only the replay, never the answer. */
    private async remember(ledger: AttemptLedger, outcome: RecipeAuthorOutcome) {
        await this.receipts!.complete(ledger.key, ledger.owner, outcome).catch((e: unknown) =>
            this.logger.warn({ message: 'Runtime recipe author: the attempt answer could not be recorded', context: RuntimeRecipeAuthorUseCase.name, error: e instanceof Error ? e : undefined }),
        );
    }

    private warnReceipts(what: string, claims: SetupTokenClaims, e: unknown) {
        this.logger.warn({
            message: `Runtime recipe author: the attempt receipts failed on ${what}`,
            context: RuntimeRecipeAuthorUseCase.name,
            error: e instanceof Error ? e : undefined,
            metadata: { organizationId: claims.organizationId, environmentId: claims.environmentId },
        });
    }

    /**
     * Kody writes the recipe (or the last one is answered again): everything
     * after the setup and the attempt were checked. `ledger`: the attempt's
     * receipt, which keeps the budget it reserved so a run taken over spends
     * that one instead of reserving again.
     */
    private async write(
        claims: SetupTokenClaims,
        body: RecipeAuthorRequest,
        setup: { sha: string; workspace?: Array<{ repositoryId: string; sha: string }> },
        product: ProductEnvironment,
        ledger: AttemptLedger | undefined,
        signal: AbortSignal | undefined,
    ): Promise<RecipeAuthorResponse> {
        const orgTeam = { organizationId: claims.organizationId, teamId: claims.teamId };
        const target = { ...orgTeam, repositoryId: claims.repositoryId, repositoryName: product.repositoryName, sha: setup.sha };
        const reader = new GitRepoReader(this.git, target);
        // A multi-repository environment: every member at the commit this setup boots it at, each read through its own repository.
        const workspace = await this.workspaceOf(product, { sha: setup.sha, ...(setup.workspace ? { workspace: setup.workspace } : {}) });
        const memberReader = (r: RecipeAuthorWorkspaceRepository) =>
            new GitRepoReader(this.git, { ...orgTeam, repositoryId: r.repositoryId, repositoryName: workspace?.byId.get(r.repositoryId)?.repositoryName ?? r.fullName, sha: r.sha });
        const ws = workspace ? recipeAuthorWorkspace(reader, { sha: setup.sha, workspace: workspace.list }, memberReader) : undefined;

        // The recipe the last setup booted with (RepoLaunch): one that answered is checked again at this commit and, when
        // it passes, answered as is, before any model or budget. One the checks now refuse, or whose boot failed, is where Kody starts.
        const last = body.last;
        let previous: PreviousAttempt[] | undefined;
        // The author's instructions changed in a way recipes written before must get (recipe-author-version.ts):
        // the last recipe booted, but is not answered as is. Kody writes it again from it, under the current rules.
        const revision = last && !last.failure && body.reauthor ? recipeAuthorRevision(body.reauthor.to) : undefined;
        if (last?.failure) {
            previous = [{ recipe: last.recipe, ...(last.files ? { files: last.files } : {}), blocker: last.failure }];
        } else if (last && revision?.reauthor) {
            previous = [
                {
                    recipe: last.recipe,
                    ...(last.files ? { files: last.files } : {}),
                    stage: 'reauthor',
                    blocker: { signature: AUTHOR_INSTRUCTIONS_CHANGED, title: `the author's instructions changed (v${body.reauthor!.from} to v${revision.version}): ${revision.reason}`, evidence: [] },
                },
            ];
        } else if (last) {
            const again = await this.checked(last.recipe, last.notes, last.files, reader, ws).catch((e: unknown) => {
                // The Git platform failed while checking the last recipe. Logged once, by the API's exception filter.
                throw withFailureContext(
                    new BadGatewayException(RECIPE_AUTHOR_GIT_UNAVAILABLE),
                    { organizationId: claims.organizationId, environmentId: claims.environmentId, failure: 'git_last_recipe_checks' },
                    e,
                );
            });
            if (again.status === 'submitted') {
                this.logger.log({
                    message: 'Runtime recipe author: the last recipe passes the checks at this commit, reused with no model call',
                    context: RuntimeRecipeAuthorUseCase.name,
                    metadata: { organizationId: claims.organizationId, environmentId: claims.environmentId },
                });
                return {
                    status: 'submitted',
                    recipe: again.recipe,
                    ...(again.notes ? { notes: said(again.notes, 1_000) } : {}),
                    ...(again.files?.length ? { files: again.files } : {}),
                    reused: true,
                    ...adjustedOf(again.adjusted),
                    usage: { inputTokens: 0, outputTokens: 0 },
                };
            }
            previous = [
                {
                    recipe: last.recipe,
                    ...(last.files ? { files: last.files } : {}),
                    stage: 'checks',
                    blocker: { signature: REUSED_RECIPE_REFUSED, title: 'the authored-recipe checks refuse it at this commit', evidence: (again.errors ?? [again.reason]).slice(0, 20) },
                },
            ];
        }

        // S-47: reserve the whole run's tokens up front under the setup's scope; the run never spends past it.
        const scopeId = setupLearnScopeId(claims.setupKey);
        const agent = await this.runners.forOrganization(orgTeam, { runId: scopeId, task: RECIPE_AUTHOR_TASK, repositoryId: claims.repositoryId, environmentId: claims.environmentId });
        if (!agent) throw new ServiceUnavailableException('No LLM is configured for the Kody Runtime of this organization');

        const now = this.now();
        const org = await this.settings?.getOrganization(claims.organizationId);
        // A setup is no pull request: its prNumber 0 counter is the repository's, for good (setupBudgetLimits).
        const limits = setupBudgetLimits(withOrgBudget(this.config.llmBudget, org?.tokenBudgetPerDay));
        let refused: { exhausted: string; spent: number; limit: number } | undefined;
        const reservation = ledger?.reservation ?? await this.usage
            .reserve({
                usage: { runId: scopeId, organizationId: claims.organizationId, repositoryId: claims.repositoryId, prNumber: 0, task: RECIPE_AUTHOR_TASK, at: now },
                orgDayStart: startOfUtcDay(now),
                decide: (spend) => {
                    const d = decideBudget(spend, limits, claims.maxTokens);
                    if (d.allowed === false) {
                        refused = d;
                        return null;
                    }
                    const tokens = Math.min(RECIPE_AUTHOR_LIMITS.maxTokens, d.remaining);
                    if (tokens < RECIPE_AUTHOR_MIN_TOKENS) {
                        // Too little left for a run: the scope that left the least is the one to name (the org's day may be tighter than the setup's).
                        refused = tightestBudgetScope(spend, limits, claims.maxTokens);
                        return null;
                    }
                    return tokens;
                },
            })
            .catch((e) => {
                if (e instanceof LlmBudgetBusyError) throw new ServiceUnavailableException({ code: 'llm_budget_busy', message: e.message });
                throw e;
            });
        if (!reservation) {
            const r = refused ?? { exhausted: 'run', spent: 0, limit: 0 };
            // The scope, spent and limit ride in the 429's body; the API's exception filter logs it with the ids.
            throw withFailureContext(
                new HttpException(
                    { statusCode: HttpStatus.TOO_MANY_REQUESTS, code: 'llm_budget_exceeded', scope: r.exhausted, spent: r.spent, limit: r.limit },
                    HttpStatus.TOO_MANY_REQUESTS,
                ),
                { organizationId: claims.organizationId, environmentId: claims.environmentId },
            );
        }

        if (ledger && !ledger.reservation) {
            ledger.spent = true;
            ledger.reservation = reservation;
            await this.receipts!.reserved(ledger.key, ledger.owner, reservation).catch((e: unknown) => this.warnReceipts('reserved', claims, e));
        }
        // Once settled, a run that takes the attempt over reserves anew instead of spending a settled reservation.
        const settledOnReceipt = () => (ledger ? this.receipts!.settled(ledger.key, ledger.owner).catch((e: unknown) => this.warnReceipts('settled', claims, e)) : undefined);

        const runner = new ObservedRunner(agent.runner);
        // Unreadable (no read URL, a database down): the default, on.
        const recommendedEgress = this.egress ? await this.egress.settings(claims.organizationId).then((s) => s.recommendedEnabled, () => true) : true;
        const pullRequests = await this.openPullRequestPaths({ ...orgTeam, repositoryId: claims.repositoryId, repositoryName: product.repositoryName });
        let result: Awaited<ReturnType<typeof authorRecipe>>;
        try {
            result = await authorRecipe(
                { runner, reader, ...(workspace ? { memberReader } : {}) },
                {
                    runId: scopeId,
                    repositoryName: product.repositoryName,
                    sha: setup.sha,
                    ...(workspace ? { workspace: workspace.list } : {}),
                    mode: 'explore',
                    // Measured on ten repositories (eval v2 vs v3, 2026-11-12): clearing reads the model is done
                    // with gave a recipe on 10/10 against 8/10, with 12% fewer input tokens. Prefetch did not pay.
                    context: { clearStaleReads: true },
                    ...(recommendedEgress ? {} : { recommendedEgress: false }),
                    ...(pullRequests.length ? { pullRequests } : {}),
                    ...(previous ? { previous } : {}),
                    maxTokens: reservation.tokens,
                    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(RECIPE_AUTHOR_TIMEOUT_MS)]) : AbortSignal.timeout(RECIPE_AUTHOR_TIMEOUT_MS),
                },
            );
        } catch (e) {
            // What the run spent before it failed is unknown: the reservation stays counted (S-47), never a free run.
            // A settle that fails too is logged with it; the run's own error is never lost behind it.
            const settleError = await this.usage
                .settle(reservation.reservationId, { inputTokens: reservation.tokens, outputTokens: 0, ...(agent.model ? { model: agent.model } : {}) })
                .then(
                    () => undefined,
                    (err: unknown) => err,
                );
            await settledOnReceipt();
            // Logged once, by the API's exception filter: the run's error is the 502's cause, the settle's rides beside it.
            throw withFailureContext(
                new BadGatewayException(RECIPE_AUTHOR_UNAVAILABLE),
                {
                    organizationId: claims.organizationId,
                    environmentId: claims.environmentId,
                    failure: 'run',
                    ...(settleError !== undefined ? { settleError: settleError instanceof Error ? settleError.message : String(settleError) } : {}),
                },
                e,
            );
        }

        const inputTokens = counted(result.usage?.inputTokens);
        const outputTokens = counted(result.usage?.outputTokens);
        const reported = inputTokens !== undefined && outputTokens !== undefined;
        const usage = reported ? { inputTokens, outputTokens } : { inputTokens: reservation.tokens, outputTokens: 0 };
        if (!reported) {
            this.logger.warn({
                message: 'Runtime recipe author: the provider reported no usage; the reservation stays counted',
                context: RuntimeRecipeAuthorUseCase.name,
                metadata: { organizationId: claims.organizationId, environmentId: claims.environmentId, reserved: reservation.tokens },
            });
        }
        const cacheReadTokens = reported ? counted(result.usage?.cacheReadTokens) : undefined;
        const cacheWriteTokens = reported ? counted(result.usage?.cacheWriteTokens) : undefined;
        // A settle that fails never discards what Kody wrote: the reservation stays counted (S-47), and it is logged.
        await this.usage
            .settle(reservation.reservationId, {
                ...usage,
                ...(cacheReadTokens ? { cacheReadTokens } : {}),
                ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
                ...(agent.model ? { model: agent.model } : {}),
            })
            .catch((err: unknown) =>
                this.logger.error({
                    message: 'Runtime recipe author: settling the run failed; the reservation stays counted',
                    context: RuntimeRecipeAuthorUseCase.name,
                    error: err instanceof Error ? err : undefined,
                    metadata: { organizationId: claims.organizationId, environmentId: claims.environmentId, reserved: reservation.tokens },
                }),
            );
        await settledOnReceipt();

        // The model failed before Kody submitted or gave up: no verdict, the setup goes on without Kody.
        // A give-up ends the run on its submit_recipe call, so an errored run carries none; the refusal limit is a verdict.
        if (result.status === 'no_recipe' && runner.last?.status === 'error' && result.rejected.length < RECIPE_AUTHOR_LIMITS.maxRejected) {
            // Logged once, by the API's exception filter.
            throw withFailureContext(new BadGatewayException(RECIPE_AUTHOR_UNAVAILABLE), {
                organizationId: claims.organizationId,
                environmentId: claims.environmentId,
                failure: 'model_call',
                steps: result.steps,
                ...usage,
            });
        }
        let answer: Awaited<ReturnType<RuntimeRecipeAuthorUseCase['checked']>>;
        try {
            answer = result.status === 'submitted' ? await this.checked(result.recipe, result.notes, result.files, reader, ws) : { status: 'no_recipe', reason: result.reason };
        } catch (e) {
            // The Git platform failed while the checks read the commit: no verdict of Kody's, the setup goes on without it.
            // Logged once, by the API's exception filter.
            throw withFailureContext(
                new BadGatewayException(RECIPE_AUTHOR_GIT_UNAVAILABLE),
                { organizationId: claims.organizationId, environmentId: claims.environmentId, failure: 'git_checks' },
                e,
            );
        }
        this.logger.log({
            message: 'Runtime recipe author finished',
            context: RuntimeRecipeAuthorUseCase.name,
            metadata: {
                organizationId: claims.organizationId,
                environmentId: claims.environmentId,
                status: answer.status,
                steps: result.steps,
                rejected: result.rejected.length,
                // Why each submission was refused, in the checks' own words (kr-nocodb, v1m: one refusal, no line said which).
                ...(result.rejected.length ? { rejectedBecause: result.rejected.map((errors) => errors.slice(0, 5).map((e) => e.slice(0, 200))) } : {}),
                ...usage,
            },
        });
        // The notes and the reason are model text, which the repository could steer: redacted (said), cut, shown as text only.
        return answer.status === 'submitted'
            ? {
                  status: 'submitted',
                  recipe: answer.recipe,
                  ...(answer.notes ? { notes: said(answer.notes, 1_000) } : {}),
                  // Code the checks accepted, bounded by them (AUTHORED_FILES_LIMITS): never redacted, the cell builds it as is.
                  ...(answer.files?.length ? { files: answer.files } : {}),
                  ...adjustedOf([...(result.status === 'submitted' ? (result.adjusted ?? []) : []), ...(answer.adjusted ?? [])]),
                  // Written now, under the instructions as they are: the next setups know which version wrote it.
                  authorVersion: RECIPE_AUTHOR_VERSION,
                  usage,
              }
            : { status: 'no_recipe', reason: said(answer.reason, 500) || 'no reason given', usage };
    }

    /**
     * The submitted recipe and its files pass the authored checks again here,
     * on the same commit, whatever the agent's tool already decided: the
     * answer never carries a recipe or a file those checks refuse. The files
     * are laid over the commit (a compose file the recipe names may be one of
     * them). A Git failure while reading is thrown, never taken for a missing
     * file: it is no verdict on the repository.
     */
    private async checked(
        recipe: string,
        notes: string | undefined,
        files: AuthoredFile[] | undefined,
        primaryReader: RepoReader,
        /** A multi-repository environment: paths may be ../<alias>/…, and services.needs is checked against its members. */
        ws?: Pick<RecipeAuthorWorkspace, 'reader' | 'policy'>,
    ): Promise<{ status: 'submitted'; recipe: string; notes?: string; files?: AuthoredFile[]; adjusted?: string[] } | { status: 'no_recipe'; reason: string; errors?: string[] }> {
        if (Buffer.byteLength(recipe) > RUNTIME_RECIPE_MAX_BYTES) return { status: 'no_recipe', reason: `the recipe is larger than ${RUNTIME_RECIPE_MAX_BYTES} bytes` };
        const reader: RepoReader = ws?.reader ?? primaryReader;
        const read = (path: string) =>
            reader.read(path, READ_LIMITS.fileBytes).catch((e: unknown) => {
                if (e instanceof RepoPathError) return null;
                throw e;
            });
        // Directories too, so a COPY source that is gone at this commit is refused here as in the agent's tool (a reused
        // recipe meets it here first). Only where the platform lists the tree: elsewhere no directory could be told apart from a missing one.
        // The suite block is Kodus's own, written from the CI evidence after the agent's checks (appendSuiteBlock): the authored
        // checks, which refuse a suite block the model writes, judge the rest, and the whole recipe must still parse. Judging it
        // whole refused every recipe Kody wrote for a repository whose CI runs an e2e suite (kr-mono on dev).
        const core = withoutSuiteBlock(recipe);
        const check = await checkAuthoredSubmission(core.text, files, (path) => fileExists(reader, path), read, await directoryExistsCheck(reader), ws?.policy);
        if (!check.ok) return { status: 'no_recipe', reason: `the checks refused the recipe: ${check.errors.join('; ')}`, errors: check.errors };
        if (core.dropped) {
            const whole = parseRecipe(recipe);
            if ('error' in whole) return { status: 'no_recipe', reason: `the checks refused the recipe: ${whole.error}`, errors: [whole.error] };
        }
        return { status: 'submitted', recipe, ...(notes ? { notes } : {}), ...(check.files?.length ? { files: check.files } : {}), ...(check.adjusted?.length ? { adjusted: check.adjusted } : {}) };
    }
}
