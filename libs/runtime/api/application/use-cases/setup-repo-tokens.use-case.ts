import {
    BadGatewayException,
    BadRequestException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { SETUP_REPO_TOKENS_CALLS_MAX, SETUP_REPO_TOKENS_REFUSAL, setupRepoTokensAttemptOf, type SetupRepoTokensAttemptKind } from '@libs/runtime/contracts/setup-repo-tokens';
import { type EnvironmentSetupRecord, SetupRepoTokensRequestSchema, type SetupRepoTokensResponse } from '@libs/runtime/run';

import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_REPO_TOKEN_ISSUER,
    type Clock,
    type ProductEnvironmentStore,
    type RuntimeApiConfig,
    type RuntimeEnvironmentSetupReader,
    type RuntimeRepoTokenIssuer,
} from '../../domain/ports';
import { RUNTIME_SETUP_CALL_COUNTER, type SetupCallCounter } from '../../domain/setup-calls';
import { RuntimeEnvironmentMembers } from '../environment-members.service';
import { errorNameOf, withFailureContext } from '../failure-context';
import { sealForRuntime } from '../secret-sealer';
import { openSetupToken } from '../setup-token';

/**
 * Whether the setup can still boot what `attempt` names. The first boot and
 * a repair boot inside the setup while it runs (the worker sets it back to setting_up
 * before Kody rewrites). A learn-loop boot runs after the setup ended blocked:
 * only while its loop has not stopped and holds hypothesis n of this very
 * setup as `trying` (the worker saves it before the boot; `n` is the
 * hypothesis, both of its boots). The record read is
 * the environment's latest setup, and the setup token that asks expires two
 * hours after the setup was requested, so a loop of an older setup, or one
 * that finished long ago, gets nothing.
 */
export function setupCanBoot(setup: EnvironmentSetupRecord, attempt: { kind: SetupRepoTokensAttemptKind; n: number }): boolean {
    if (attempt.kind === 'boot' || attempt.kind === 'repair') return setup.state === 'setting_up';
    if (setup.state !== 'blocked' || !setup.learn || setup.learn.stopped) return false;
    return setup.learn.attempts.some((a) => a.setupKey === setup.key && a.n === attempt.n && a.result === 'trying');
}

/**
 * POST /internal/runtime/setup-repo-tokens (contract: libs/runtime/run/
 * setup-repo-tokens.ts; the product's rules: libs/runtime/contracts/
 * setup-repo-tokens.ts). The cell revokes a download token after
 * its first fetch, so each later boot of a setup (a repair of Kody's recipe,
 * a learn-loop boot) asks for new ones with the setup token, as does its
 * first boot when the command's have run out (`boot`). Each is a
 * contents:read installation token of one repository (ADR-002), sealed to the
 * setup key like the setup command's; none is logged or answered in the clear.
 */
@Injectable()
export class RuntimeSetupRepoTokensUseCase {
    private readonly logger = createLogger(RuntimeSetupRepoTokensUseCase.name);

    constructor(
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        @Inject(RUNTIME_ENVIRONMENT_SETUP_READER)
        private readonly setups: RuntimeEnvironmentSetupReader,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly products: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(RUNTIME_REPO_TOKEN_ISSUER)
        private readonly repoTokens: RuntimeRepoTokenIssuer,
        @Inject(RUNTIME_SETUP_CALL_COUNTER)
        private readonly calls: SetupCallCounter,
        @Inject(RuntimeEnvironmentMembers)
        private readonly members: RuntimeEnvironmentMembers,
    ) {}

    async execute(input: { authorization?: string; body: unknown }): Promise<SetupRepoTokensResponse> {
        const claims = openSetupToken(this.config, input.authorization, this.now(), 'setup repository tokens');
        const parsed = SetupRepoTokensRequestSchema.safeParse(input.body);
        if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        const attempt = setupRepoTokensAttemptOf(parsed.data.attempt);

        // The setup the token names must be the environment's current one, of its org and repository; anything else reads as absent.
        const setup = await this.setups.get(claims.organizationId, claims.environmentId);
        if (
            !setup ||
            setup.organizationId !== claims.organizationId ||
            setup.environmentId !== claims.environmentId ||
            setup.key !== claims.setupKey ||
            setup.repositoryId !== claims.repositoryId
        ) {
            throw new NotFoundException('Setup not found');
        }
        const product = await this.products.get(claims.organizationId, claims.environmentId);
        if (!product || product.organizationId !== claims.organizationId || product.repositoryId !== claims.repositoryId) {
            throw new NotFoundException('Setup not found');
        }
        if (!setupCanBoot(setup, attempt)) {
            throw new HttpException(
                { statusCode: HttpStatus.CONFLICT, code: SETUP_REPO_TOKENS_REFUSAL.finished, message: 'This setup boots nothing more for this attempt' },
                HttpStatus.CONFLICT,
            );
        }
        if (!this.config.secretSealKey) {
            throw new ServiceUnavailableException('RUNTIME_SECRET_SEAL_KEY is not configured; the download token is not handed over plain');
        }

        const meta = { organizationId: claims.organizationId, environmentId: claims.environmentId, attempt: parsed.data.attempt };
        // Each refusal below is logged once, by the API's exception filter, with these ids on the exception.
        const counted = await this.calls.take(`setup-repo-tokens\0${claims.setupKey}\0${attempt.kind}`, SETUP_REPO_TOKENS_CALLS_MAX[attempt.kind], new Date(claims.exp * 1000)).catch((e: unknown) => {
            throw withFailureContext(new ServiceUnavailableException('The setup call counter is unavailable; ask again'), meta, e);
        });
        if (!counted) {
            throw withFailureContext(
                new HttpException(
                    { statusCode: HttpStatus.TOO_MANY_REQUESTS, code: SETUP_REPO_TOKENS_REFUSAL.tooMany, message: 'This setup asked for more download tokens than its boots need' },
                    HttpStatus.TOO_MANY_REQUESTS,
                ),
                meta,
            );
        }

        const orgTeam = { organizationId: claims.organizationId, teamId: claims.teamId };
        const mint = async (repositoryId: string, repositoryName: string) => {
            try {
                return sealForRuntime(this.config, await this.repoTokens.issue({ ...orgTeam, repositoryId, repositoryName }), claims.setupKey);
            } catch (e) {
                // The issuer's own refusals are product-authored; anything else may carry request details, so only its name rides along.
                const context = { ...meta, repositoryId, errorName: errorNameOf(e) };
                if (e instanceof HttpException) throw withFailureContext(e, context);
                throw withFailureContext(new BadGatewayException('The repository download token could not be issued'), context);
            }
        };

        const repoToken = await mint(product.repositoryId, product.repositoryName);
        // The members this setup boots that are still in the environment; one removed since gets none (its claim is refused, naming it).
        const booted = (setup.workspace ?? []).filter((r) => r.role === 'member' && r.repositoryId !== product.repositoryId);
        const workspace: NonNullable<SetupRepoTokensResponse['workspace']> = [];
        if (booted.length) {
            const current = new Map((await this.members.list(product)).filter((m) => m.role === 'member').map((m) => [m.repositoryId, m]));
            for (const ref of booted) {
                const member = current.get(ref.repositoryId);
                if (!member) continue;
                workspace.push({ repositoryId: member.repositoryId, sealedRepoToken: await mint(member.repositoryId, member.repositoryName) });
            }
        }
        this.logger.log({
            message: 'Runtime setup repo tokens issued',
            context: RuntimeSetupRepoTokensUseCase.name,
            metadata: { ...meta, repositories: 1 + workspace.length, skipped: booted.length - workspace.length },
        });
        return { repoToken, ...(workspace.length ? { workspace } : {}) };
    }
}
