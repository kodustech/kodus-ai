import { createLogger } from '@libs/core/log/logger';

import { AxiosError } from 'axios';

import { AxiosLicenseService } from '@libs/core/infrastructure/config/axios/microservices/license.axios';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import {
    BindPrimaryConnectionResult,
    ConsumeTrialReviewCreditResult,
    CreditBalance,
    CreditCheckoutResult,
    CreditLedgerEntry,
    CreditLedgerEntryType,
    DebitCreditsEntry,
    DebitCreditsResult,
    ILicenseService,
    OrganizationLicenseValidationResult,
    ReleaseConnectionResult,
    UserWithLicense,
    WorkspaceConnectionLicenses,
} from './interfaces/license.interface';

/**
 * True when the license read never produced an answer: no HTTP response at
 * all (network error, DNS, timeout), a transport-level timeout status, a
 * server-side failure, or a rate limit. Those are transient. A client error
 * (401, 403, 404) is a real answer and keeps today's `{ valid: false }`
 * contract.
 */
function isLicenseServiceUnreachable(error: unknown): boolean {
    const status = (error as AxiosError)?.response?.status;

    if (status == null) {
        return true;
    }

    return (
        status === 408 || // request timeout
        status === 425 || // too early
        status === 499 || // client closed the request (gateway)
        status === 429 || // rate limited
        status >= 500
    );
}

/** The Git connection a licence call is for, when the caller is routed to one. */
const connectionParams = (organizationAndTeamData: OrganizationAndTeamData) =>
    organizationAndTeamData.integrationId
        ? { connectionId: organizationAndTeamData.integrationId }
        : {};

/**
 * LicenseService handles organization and user license validation via billing service endpoints.
 */
export class LicenseService implements ILicenseService {
    private readonly logger = createLogger(LicenseService.name);
    private readonly licenseRequest: AxiosLicenseService;

    constructor() {
        this.licenseRequest = new AxiosLicenseService();
    }

    /**
     * Validate organization license by calling the billing service endpoint.
     * @param organizationAndTeamData Organization and team identifiers
     * @returns Promise with license validation result
     */
    async validateOrganizationLicense(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationLicenseValidationResult> {
        try {
            const response = await this.licenseRequest.get(
                'validate-org-license',
                {
                    params: {
                        organizationId: organizationAndTeamData.organizationId,
                        teamId: organizationAndTeamData.teamId,
                        ...connectionParams(organizationAndTeamData),
                    },
                },
            );

            return response;
        } catch (error) {
            this.logger.error({
                message: 'ValidateOrganizationLicense not working',
                context: LicenseService.name,
                error: error,
                serviceName: 'LicenseService validateOrganizationLicense',
                metadata: {
                    ...organizationAndTeamData,
                },
            });
            // A failed read says nothing about the license. Report it as such
            // so the caller can tell "billing could not answer" from "the org
            // has no subscription" instead of posting "your trial has ended".
            return {
                valid: false,
                ...(isLicenseServiceUnreachable(error)
                    ? { unavailable: true }
                    : {}),
            };
        }
    }

    /**
     * Provision a Kodus-managed trial for the organization via billing.
     *
     * The trial used to be created only by the browser at the end of
     * onboarding; if that client-side call never ran (tab closed, network
     * drop) or failed silently, the org was left without a license. This
     * server-side path makes provisioning reliable and retries transient
     * failures. The billing endpoint is idempotent (409 when a license
     * already exists), so repeating the call is safe.
     */
    async startTrial(
        organizationAndTeamData: OrganizationAndTeamData,
        byok: boolean,
    ): Promise<boolean> {
        const MAX_ATTEMPTS = 3;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                await this.licenseRequest.post('trial', {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    byok,
                });
                return true;
            } catch (error) {
                const status = (error as AxiosError)?.response?.status;

                // A license already exists — the trial is effectively in
                // place, so this is a success from our perspective.
                if (status === 409) {
                    return true;
                }

                // Client errors other than rate limiting won't be fixed by
                // retrying (bad payload, org not found, etc.).
                const isRetriable =
                    status === undefined || status === 429 || status >= 500;

                if (!isRetriable || attempt === MAX_ATTEMPTS) {
                    this.logger.error({
                        message: 'StartTrial failed to provision trial',
                        context: LicenseService.name,
                        error,
                        serviceName: 'LicenseService startTrial',
                        metadata: {
                            ...organizationAndTeamData,
                            byok,
                            attempt,
                            status,
                        },
                    });
                    return false;
                }

                // Exponential backoff before the next attempt.
                await new Promise((resolve) =>
                    setTimeout(resolve, 500 * 2 ** (attempt - 1)),
                );
            }
        }

        return false;
    }

    async consumeTrialReviewCredit(
        organizationAndTeamData: OrganizationAndTeamData,
        usageKey?: string,
    ): Promise<ConsumeTrialReviewCreditResult> {
        try {
            return await this.licenseRequest.post(
                'trial-review-credit/consume',
                {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    usageKey,
                },
            );
        } catch (error) {
            const responseData = (error as AxiosError)?.response
                ?.data as ConsumeTrialReviewCreditResult;

            if (responseData?.allowed === false) {
                return responseData;
            }

            this.logger.error({
                message: 'ConsumeTrialReviewCredit not working',
                context: LicenseService.name,
                error,
                serviceName: 'LicenseService consumeTrialReviewCredit',
                metadata: {
                    ...organizationAndTeamData,
                    usageKey,
                },
            });

            return {
                allowed: false,
                reason: 'CONSUME_TRIAL_REVIEW_CREDIT_FAILED',
            };
        }
    }

    /**
     * Get all users with license by calling the billing service endpoint.
     * @param organizationAndTeamData Organization and team identifiers
     * @returns Promise with array of users with license
     */
    async getAllUsersWithLicense(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<UserWithLicense[]> {
        try {
            return await this.licenseRequest.get('users-with-license', {
                params: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    ...connectionParams(organizationAndTeamData),
                },
            });
        } catch (error) {
            this.logger.error({
                message: 'GetAllUsersWithLicense not working',
                error: error,
                context: LicenseService.name,
                serviceName: 'LicenseService getAllUsersWithLicense',
                metadata: {
                    ...organizationAndTeamData,
                },
            });
            return [];
        }
    }

    /**
     * The billing service's `users-with-license` endpoint filters on
     * `licenseStatus = ACTIVE` and returns only `git_id`, so on cloud there is
     * no way to tell a revoked seat from one that never existed. Every user it
     * returns is by definition active. Surfacing revoked seats here needs a
     * billing-service change; until then this reports the active seats with an
     * explicit status so callers do not have to guess.
     */
    async getAllUsersEverWithLicense(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<UserWithLicense[]> {
        const users = await this.getAllUsersWithLicense(
            organizationAndTeamData,
        );

        return users.map((user) => ({
            git_id: user.git_id,
            status: user.status ?? 'active',
        }));
    }

    /**
     * Assign license to a user by calling the billing service endpoint.
     * @param organizationAndTeamData Organization and team identifiers
     * @param userGitId Git ID of the user
     * @param provider The git provider (e.g., 'github', 'gitlab')
     * @returns Promise with boolean indicating success
     */
    async assignLicense(
        organizationAndTeamData: OrganizationAndTeamData,
        userGitId: string,
        provider: string,
    ): Promise<boolean> {
        try {
            const result = await this.licenseRequest.post('assign-license', {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                ...connectionParams(organizationAndTeamData),
                users: [
                    {
                        gitId: userGitId,
                        gitTool: provider.toLowerCase(),
                        licenseStatus: 'active',
                    },
                ],
                editedBy: {
                    email: 'system@kodus.ai', // Or some system identifier
                },
                userName: 'System Auto-Assign',
            });

            if (result?.failed?.length > 0) {
                return false;
            }

            return true;
        } catch (error) {
            this.logger.error({
                message: 'AssignLicense not working',
                error: error,
                context: LicenseService.name,
                serviceName: 'LicenseService assignLicense',
                metadata: {
                    ...organizationAndTeamData,
                    userGitId,
                    provider,
                },
            });
            return false;
        }
    }

    /**
     * Release a user's seat by calling the billing service endpoint.
     * @param organizationAndTeamData Organization and team identifiers
     * @param userGitId Git ID of the user
     * @returns Promise with boolean indicating success
     */
    async unassignLicenses(
        organizationAndTeamData: OrganizationAndTeamData,
        userGitIds: string[],
        provider: string,
    ): Promise<{ revoked: string[]; failed: string[] }> {
        if (!userGitIds?.length) {
            return { revoked: [], failed: [] };
        }

        try {
            const result = await this.licenseRequest.post('assign-license', {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                ...connectionParams(organizationAndTeamData),
                users: userGitIds.map((gitId) => ({
                    gitId,
                    // The billing service rejects the whole request with a 400
                    // when a user entry is missing gitTool.
                    gitTool: provider?.toLowerCase(),
                    licenseStatus: 'inactive',
                })),
                editedBy: {
                    email: 'system@kodus.ai',
                },
                userName: 'System Seat Reclaim',
            });

            const revoked = (result?.successful ?? []).map(
                (license: { git_id: string }) => String(license.git_id),
            );
            const revokedSet = new Set(revoked);

            return {
                revoked,
                failed: userGitIds.filter((gitId) => !revokedSet.has(gitId)),
            };
        } catch (error) {
            this.logger.error({
                message: 'UnassignLicenses not working',
                error: error,
                context: LicenseService.name,
                serviceName: 'LicenseService unassignLicenses',
                metadata: {
                    ...organizationAndTeamData,
                    userGitIds,
                },
            });
            return { revoked: [], failed: userGitIds };
        }
    }

    /**
     * Asks billing to name the workspace connection whose plan and seats
     * live on the workspace licence, and answers the primary billing holds
     * afterwards: billing keeps an existing one, and never names a
     * connection billed on its own licence.
     */
    async bindPrimaryConnection(
        organizationAndTeamData: OrganizationAndTeamData,
        connectionId: string,
    ): Promise<BindPrimaryConnectionResult> {
        try {
            const result = await this.licenseRequest.post(
                'connections/primary',
                {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    connectionId,
                },
            );
            const primaryConnectionId: string | null =
                result?.primaryConnectionId ?? null;
            this.logger.log({
                message: 'license_primary_connection_bound',
                context: LicenseService.name,
                metadata: {
                    ...organizationAndTeamData,
                    connectionId,
                    primaryConnectionId,
                },
            });
            return { ok: true, licensed: true, primaryConnectionId };
        } catch (error) {
            // Billing's own "no licence for this workspace": nothing to bind.
            // A 404 without that body is a billing service that predates the
            // route, and must not read as answered.
            const response = (error as AxiosError<{ error?: string }>)
                ?.response;
            if (
                response?.status === 404 &&
                response.data?.error === 'LICENSE_NOT_FOUND'
            ) {
                return { ok: true, licensed: false };
            }
            this.logger.error({
                message: 'license_primary_connection_bind_failed',
                context: LicenseService.name,
                error,
                metadata: { ...organizationAndTeamData, connectionId },
            });
            return { ok: false };
        }
    }

    async releaseConnection(
        organizationAndTeamData: OrganizationAndTeamData,
        connectionId: string,
    ): Promise<ReleaseConnectionResult> {
        try {
            const result = await this.licenseRequest.post(
                'connections/release',
                {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    connectionId,
                },
            );
            const released = Boolean(result?.released);
            this.logger.log({
                message: 'license_connection_released',
                context: LicenseService.name,
                metadata: {
                    ...organizationAndTeamData,
                    connectionId,
                    released,
                },
            });
            return released ? 'released' : 'not_held';
        } catch (error) {
            this.logger.error({
                message: 'license_connection_release_failed',
                context: LicenseService.name,
                error,
                metadata: { ...organizationAndTeamData, connectionId },
            });
            return 'failed';
        }
    }

    // Cloud seats are held per connection in billing: none predate them.
    async attributeLegacySeats(): Promise<void> {
        return;
    }

    // Cloud seats are held per connection in billing, which keeps them.
    async detachConnectionSeats(): Promise<void> {
        return;
    }

    async getConnectionLicenses(
        organizationAndTeamData: OrganizationAndTeamData,
        options: { timeoutMs?: number } = {},
    ): Promise<WorkspaceConnectionLicenses | null> {
        try {
            const result = await this.licenseRequest.get('connections', {
                params: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
                ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
            });
            // Only a connection with its own subscription keeps its own
            // plan: a licence row left by a failed seat call or an abandoned
            // checkout does not stop it from taking the workspace plan. An
            // entry billing does not fully describe is not read as either.
            const connections = (result?.connections ?? []) as Array<{
                connectionId?: string;
                ownSubscription?: boolean;
            }>;
            if (
                connections.some(
                    (connection) =>
                        typeof connection?.ownSubscription !== 'boolean' ||
                        typeof connection?.connectionId !== 'string' ||
                        !connection.connectionId,
                )
            ) {
                this.logger.warn({
                    message: 'license_connection_subscription_unknown',
                    context: LicenseService.name,
                    metadata: { ...organizationAndTeamData },
                });
                return null;
            }
            return {
                primaryConnectionId: result?.primaryConnectionId ?? null,
                ownLicenceConnectionIds: connections
                    .filter((connection) => connection.ownSubscription === true)
                    .map((connection) => connection.connectionId as string),
            };
        } catch (error) {
            this.logger.error({
                message: 'license_connection_licenses_read_failed',
                context: LicenseService.name,
                error,
                metadata: {
                    ...organizationAndTeamData,
                    timeoutMs: options.timeoutMs ?? null,
                },
            });
            return null;
        }
    }

    // ── Prepaid credits ("Kodus as the provider") ────────────────────────

    async getCreditBalance(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<CreditBalance | null> {
        try {
            return await this.licenseRequest.get('credits/balance', {
                params: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
            });
        } catch (error) {
            this.logger.error({
                message: 'GetCreditBalance not working',
                context: LicenseService.name,
                error,
                serviceName: 'LicenseService getCreditBalance',
                metadata: { ...organizationAndTeamData },
            });
            return null;
        }
    }

    async listCreditLedger(
        organizationAndTeamData: OrganizationAndTeamData,
        options: {
            limit?: number;
            before?: string;
            types?: CreditLedgerEntryType[];
        } = {},
    ): Promise<CreditLedgerEntry[]> {
        try {
            const response = await this.licenseRequest.get('credits/ledger', {
                params: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    limit: options.limit,
                    before: options.before,
                    types: options.types?.join(','),
                },
            });
            return response?.entries ?? [];
        } catch (error) {
            this.logger.error({
                message: 'ListCreditLedger not working',
                context: LicenseService.name,
                error,
                serviceName: 'LicenseService listCreditLedger',
                metadata: { ...organizationAndTeamData },
            });
            return [];
        }
    }

    // Deliberately NOT swallowed: the metering sweep keys retries on this
    // throwing. A duplicate usageKey is a `skipped` count in the 200 body,
    // never an error, so a retried batch is safe.
    async debitCredits(
        organizationAndTeamData: OrganizationAndTeamData,
        entries: DebitCreditsEntry[],
    ): Promise<DebitCreditsResult> {
        return this.licenseRequest.post('credits/debit', {
            organizationId: organizationAndTeamData.organizationId,
            teamId: organizationAndTeamData.teamId,
            entries,
        });
    }

    async createCreditCheckout(
        organizationAndTeamData: OrganizationAndTeamData,
        creditUsd: number,
    ): Promise<CreditCheckoutResult | null> {
        try {
            return await this.licenseRequest.post('credits/checkout', {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                creditUsd,
            });
        } catch (error) {
            this.logger.error({
                message: 'CreateCreditCheckout not working',
                context: LicenseService.name,
                error,
                serviceName: 'LicenseService createCreditCheckout',
                metadata: { ...organizationAndTeamData, creditUsd },
            });
            return null;
        }
    }
}
