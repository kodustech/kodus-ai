import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { createLogger } from '@libs/core/log/logger';
import { shSingleQuote } from '@libs/code-review/infrastructure/adapters/services/shell-quote';

import { buildGitAuthHeader } from '../../providers/git-auth-header';
import {
    classifyDirectProbe,
    EgressBlockReason,
    EgressProbeOutcome,
    PROBE_LISTING_TIMEOUT_SECONDS,
    repositoryHost,
    sanitizeProbeDetail,
} from './egress-probe';

/** PostHog flag that turns the probe on, per organization. */
export const SANDBOX_EGRESS_PROBE_FLAG = 'sandbox-egress-probe';

const DAY_MS = 24 * 60 * 60 * 1000;
// One at a time per worker: probe sandboxes share the E2B concurrency cap
// with review sandboxes, and a review must never wait on a probe.
const DEFAULT_MAX_IN_FLIGHT = 1;
const ENSURE_GIT_TIMEOUT_MS = 180_000;

export interface EgressProbeRequest {
    organizationId: string;
    teamId?: string;
    platform: PlatformType;
    cloneUrl: string;
    authToken: string;
    authUsername?: string;
}

export interface EgressProbeClaim {
    key: string;
    organizationId: string;
    host: string;
    platform: PlatformType;
}

export interface EgressProbeRecord extends EgressProbeClaim {
    teamId?: string;
    outcome: EgressProbeOutcome;
    reason?: EgressBlockReason;
    detail?: string;
    exitCode: number;
    probedAt: Date;
}

export interface EgressProbeStore {
    /**
     * Takes the right to probe `claim.key` now. False when it was probed
     * less than `minIntervalMs` ago, by this worker or another one.
     */
    claim(
        claim: EgressProbeClaim,
        now: Date,
        minIntervalMs: number,
    ): Promise<boolean>;
    record(record: EgressProbeRecord): Promise<void>;
}

export interface ProbeCommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/** A throwaway sandbox WITHOUT the egress proxy. */
export interface ProbeSandbox {
    run(
        command: string,
        opts?: {
            envs?: Record<string, string>;
            timeoutMs?: number;
            user?: 'root';
        },
    ): Promise<ProbeCommandResult>;
    kill(): Promise<void>;
}

export interface SandboxEgressProbeDeps {
    store: EgressProbeStore;
    createSandbox: () => Promise<ProbeSandbox>;
    isEnabled: (request: EgressProbeRequest) => Promise<boolean>;
    now?: () => Date;
    maxInFlight?: number;
    minIntervalMs?: number;
}

/**
 * Finds out, from real reviews, which organizations need the egress proxy.
 *
 * After a review sandbox cloned through the proxy (so the fixed IP works), the
 * probe lists the same repository's branches from a separate sandbox that has
 * no proxy. Refused → the org's Git host allowlists our IP and must keep the
 * proxy. Answered → it does not. One record per org and Git host.
 *
 * It never touches the review sandbox, never blocks the review and never
 * throws: every failure is logged and dropped. At most `maxInFlight` probes
 * run at once per worker and an org/host is probed at most once a day.
 */
export class SandboxEgressProbeService {
    private readonly logger = createLogger(SandboxEgressProbeService.name);
    private inFlight = 0;
    private readonly now: () => Date;
    private readonly maxInFlight: number;
    private readonly minIntervalMs: number;

    constructor(private readonly deps: SandboxEgressProbeDeps) {
        this.now = deps.now ?? (() => new Date());
        this.maxInFlight = deps.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
        this.minIntervalMs = deps.minIntervalMs ?? DAY_MS;
    }

    async probe(request: EgressProbeRequest): Promise<void> {
        // An anonymous clone reads a public repository: no allow list applies.
        if (!request.authToken) return;
        const host = repositoryHost(request.cloneUrl);
        if (!host) return;
        // Reserved before the first await so concurrent calls see the cap.
        if (this.inFlight >= this.maxInFlight) return;
        this.inFlight++;

        let sandbox: ProbeSandbox | undefined;
        try {
            if (!(await this.deps.isEnabled(request))) return;

            const claim: EgressProbeClaim = {
                key: `${request.organizationId}:${host}`,
                organizationId: request.organizationId,
                host,
                platform: request.platform,
            };
            if (
                !(await this.deps.store.claim(
                    claim,
                    this.now(),
                    this.minIntervalMs,
                ))
            )
                return;

            const authHeader = buildGitAuthHeader(
                request.platform,
                request.authToken,
                request.authUsername,
            );

            sandbox = await this.deps.createSandbox();
            await sandbox.run(
                'command -v git >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1)',
                { user: 'root', timeoutMs: ENSURE_GIT_TIMEOUT_MS },
            );

            // The token travels in an env var, never on the command line.
            const result = await sandbox.run(
                `GIT_TERMINAL_PROMPT=0 timeout ${PROBE_LISTING_TIMEOUT_SECONDS} git -c http.extraHeader="$GIT_AUTH_HEADER" ls-remote --heads ${shSingleQuote(request.cloneUrl)} >/dev/null`,
                {
                    envs: { GIT_AUTH_HEADER: authHeader },
                    timeoutMs: (PROBE_LISTING_TIMEOUT_SECONDS + 15) * 1000,
                },
            );

            const verdict = classifyDirectProbe(result.exitCode, result.stderr);
            const record: EgressProbeRecord = {
                ...claim,
                ...(request.teamId && { teamId: request.teamId }),
                outcome: verdict.outcome,
                ...(verdict.reason && { reason: verdict.reason }),
                ...(verdict.outcome === 'direct_blocked' && {
                    detail: sanitizeProbeDetail(result.stderr, [
                        request.authToken,
                        authHeader,
                    ]),
                }),
                exitCode: result.exitCode,
                probedAt: this.now(),
            };
            await this.deps.store.record(record);

            this.logger.log({
                message: `[egress-probe] ${record.outcome} org=${record.organizationId} host=${record.host}${record.reason ? ` reason=${record.reason}` : ''}`,
                context: SandboxEgressProbeService.name,
                metadata: {
                    organizationId: record.organizationId,
                    host: record.host,
                    platform: record.platform,
                    outcome: record.outcome,
                    reason: record.reason,
                    exitCode: record.exitCode,
                },
            });
        } catch (error) {
            this.logger.warn({
                message: `[egress-probe] probe failed; nothing recorded`,
                context: SandboxEgressProbeService.name,
                metadata: {
                    organizationId: request.organizationId,
                    host,
                    error:
                        error instanceof Error
                            ? sanitizeProbeDetail(error.message, [
                                  request.authToken,
                              ])
                            : 'unknown',
                },
            });
        } finally {
            this.inFlight--;
            if (sandbox) {
                await sandbox.kill().catch(() => undefined);
            }
        }
    }
}
