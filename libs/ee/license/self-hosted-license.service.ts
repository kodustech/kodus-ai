import * as crypto from 'crypto';
import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';

import {
    ConsumeTrialReviewCreditResult,
    ILicenseService,
    OrganizationLicenseValidationResult,
    SelfHostedLicensePayload,
    SubscriptionStatus,
    UserWithLicense,
    DebitCreditsResult,
} from './interfaces/license.interface';

// Ed25519 public key used to verify self-hosted license JWTs.
// This is the public half of the keypair held by Kodus for signing licenses.
const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAig1JYVU3PCPOY18JGKsMdcoPeDMrGRCRb5XPZeLniZc=
-----END PUBLIC KEY-----`;

type AssignedUserEntry = {
    gitId: string;
    status: 'active' | 'inactive';
};

function isLegacyFormat(
    users: unknown,
): users is string[] {
    if (!Array.isArray(users)) return false;
    return users.length === 0 || typeof users[0] === 'string';
}

@Injectable()
export class SelfHostedLicenseService implements ILicenseService {
    private readonly logger = createLogger(SelfHostedLicenseService.name);

    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    async validateOrganizationLicense(
        _organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationLicenseValidationResult> {
        return {
            valid: true,
            subscriptionStatus: SubscriptionStatus.LICENSED_SELF_HOSTED,
            planType: 'enterprise',
            numberOfLicenses: 0, // 0 = unlimited seats
        };
    }

    async getAllUsersWithLicense(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<UserWithLicense[]> {
        try {
            const assignedUsers = await this.getAssignedUsers(
                organizationAndTeamData,
            );
            return assignedUsers
                .filter((u) => u.status === 'active')
                .map((u) => ({ git_id: u.gitId }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting assigned users',
                context: SelfHostedLicenseService.name,
                error,
            });
            return [];
        }
    }

    async getAllUsersEverWithLicense(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<UserWithLicense[]> {
        try {
            const assignedUsers = await this.getAssignedUsers(
                organizationAndTeamData,
            );
            return assignedUsers.map((u) => ({
                git_id: u.gitId,
                status: u.status,
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting all users ever with license',
                context: SelfHostedLicenseService.name,
                error,
            });
            return [];
        }
    }

    async assignLicense(
        organizationAndTeamData: OrganizationAndTeamData,
        userGitId: string,
        _provider: string,
    ): Promise<boolean> {
        try {
            const validation = await this.validateOrganizationLicense(
                organizationAndTeamData,
            );
            if (!validation.valid) {
                return false;
            }

            const assignedUsers = await this.getAssignedUsers(
                organizationAndTeamData,
            );

            const existing = assignedUsers.find(
                (u) => u.gitId === userGitId,
            );
            if (existing) {
                if (existing.status === 'active') {
                    return true;
                }

                const maxSeats = validation.numberOfLicenses || 0;
                if (maxSeats > 0) {
                    const globalCount =
                        await this.getGlobalAssignedUsersCount();
                    if (globalCount >= maxSeats) {
                        this.logger.warn({
                            message:
                                'Cannot reactivate license: global seat limit reached',
                            context: SelfHostedLicenseService.name,
                            metadata: {
                                currentGlobal: globalCount,
                                max: maxSeats,
                                userGitId,
                            },
                        });
                        return false;
                    }
                }

                existing.status = 'active';
                await this.saveAssignedUsers(
                    organizationAndTeamData,
                    assignedUsers,
                );
                return true;
            }

            // Check seat limit globally across all orgs
            const maxSeats = validation.numberOfLicenses || 0;
            if (maxSeats > 0) {
                const globalCount = await this.getGlobalAssignedUsersCount();
                if (globalCount >= maxSeats) {
                    this.logger.warn({
                        message:
                            'Cannot assign license: global seat limit reached',
                        context: SelfHostedLicenseService.name,
                        metadata: {
                            currentGlobal: globalCount,
                            max: maxSeats,
                            userGitId,
                        },
                    });
                    return false;
                }
            }

            assignedUsers.push({ gitId: userGitId, status: 'active' });
            await this.saveAssignedUsers(
                organizationAndTeamData,
                assignedUsers,
            );
            return true;
        } catch (error) {
            this.logger.error({
                message: 'Error assigning license',
                context: SelfHostedLicenseService.name,
                error,
            });
            return false;
        }
    }

    async unassignLicense(
        organizationAndTeamData: OrganizationAndTeamData,
        userGitId: string,
    ): Promise<boolean> {
        const { failed } = await this.unassignLicenses(
            organizationAndTeamData,
            [userGitId],
        );

        return failed.length === 0;
    }

    /**
     * Batched so a bulk prune performs a single read-modify-write of the
     * assigned-users parameter. Revoking one user per call concurrently would
     * lose updates, leaving seats that look released but are still occupied.
     */
    async unassignLicenses(
        organizationAndTeamData: OrganizationAndTeamData,
        userGitIds: string[],
    ): Promise<{ revoked: string[]; failed: string[] }> {
        if (!userGitIds?.length) {
            return { revoked: [], failed: [] };
        }

        try {
            const assignedUsers = await this.getAssignedUsers(
                organizationAndTeamData,
            );
            const byGitId = new Map(assignedUsers.map((u) => [u.gitId, u]));

            for (const gitId of userGitIds) {
                const existing = byGitId.get(gitId);

                // Revoking a seat the user never held is a no-op, not a failure.
                if (existing) {
                    existing.status = 'inactive';
                }
            }

            await this.saveAssignedUsers(organizationAndTeamData, assignedUsers);

            return { revoked: [...userGitIds], failed: [] };
        } catch (error) {
            this.logger.error({
                message: 'Error unassigning licenses',
                context: SelfHostedLicenseService.name,
                error,
            });
            return { revoked: [], failed: [...userGitIds] };
        }
    }

    async consumeTrialReviewCredit(
        _organizationAndTeamData: OrganizationAndTeamData,
        _usageKey?: string,
    ): Promise<ConsumeTrialReviewCreditResult> {
        return {
            allowed: true,
            reason: 'SELF_HOSTED',
        };
    }

    // Trials are a cloud-billing concept; self-hosted installs are licensed
    // via signed keys, so there is nothing to provision here.
    async startTrial(
        _organizationAndTeamData: OrganizationAndTeamData,
        _byok: boolean,
    ): Promise<boolean> {
        return false;
    }

    // Prepaid credits are a cloud product: self-hosted has no Kodus-routed
    // provider (the id is hidden by isKodusProviderAvailable), so there is
    // never a balance to gate on or a debit to send.
    async getCreditBalance(): Promise<null> {
        return null;
    }

    async listCreditLedger(): Promise<[]> {
        return [];
    }

    async debitCredits(): Promise<DebitCreditsResult> {
        return {
            applied: 0,
            skipped: 0,
            appliedUsd: 0,
            balanceUsd: 0,
            lowBalance: false,
            exhausted: false,
        };
    }

    async createCreditCheckout(): Promise<null> {
        return null;
    }

    private async getAssignedUsers(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<AssignedUserEntry[]> {
        try {
            const param = await this.organizationParametersService.findByKey(
                OrganizationParametersKey.LICENSE_ASSIGNED_USERS,
                organizationAndTeamData,
            );
            if (
                param?.configValue?.users &&
                Array.isArray(param.configValue.users)
            ) {
                const raw = param.configValue.users;
                if (isLegacyFormat(raw)) {
                    return raw.map((id) => ({
                        gitId: id,
                        status: 'active' as const,
                    }));
                }
                return raw as AssignedUserEntry[];
            }
        } catch {
            // Not found yet
        }
        return [];
    }

    private async saveAssignedUsers(
        organizationAndTeamData: OrganizationAndTeamData,
        users: AssignedUserEntry[],
    ): Promise<void> {
        await this.organizationParametersService.createOrUpdateConfig(
            OrganizationParametersKey.LICENSE_ASSIGNED_USERS,
            { users },
            organizationAndTeamData,
        );
    }

    /**
     * Count assigned users across ALL organizations in this instance.
     * Uses a Set to deduplicate users that may appear in multiple orgs.
     */
    private async getGlobalAssignedUsersCount(): Promise<number> {
        try {
            const allParams = await this.organizationParametersService.find({
                configKey: OrganizationParametersKey.LICENSE_ASSIGNED_USERS,
            });

            const uniqueUsers = new Set<string>();
            for (const param of allParams) {
                const raw = param.configValue?.users;
                if (Array.isArray(raw)) {
                    const entries: AssignedUserEntry[] = isLegacyFormat(raw)
                        ? raw.map((id) => ({ gitId: id, status: 'active' as const }))
                        : (raw as AssignedUserEntry[]);
                    for (const entry of entries) {
                        if (entry.status === 'active') {
                            uniqueUsers.add(entry.gitId);
                        }
                    }
                }
            }

            return uniqueUsers.size;
        } catch {
            return 0;
        }
    }

    /**
     * Decode and validate a license key without checking expiration.
     * Kept for the `/license/activate` endpoint, which still accepts a key
     * and echoes its payload; validation no longer depends on it.
     */
    decodePayload(token: string): SelfHostedLicensePayload | null {
        return this.verifyAndDecode(token);
    }

    /**
     * No-op: validation no longer caches, but the license controller still
     * calls this after activating a key.
     */
    clearCache(): void {}

    private verifyAndDecode(token: string): SelfHostedLicensePayload | null {
        try {
            const parts = token.split('.');
            if (parts.length !== 3) {
                this.logger.warn({
                    message: 'Invalid JWT format: expected 3 parts',
                    context: SelfHostedLicenseService.name,
                });
                return null;
            }

            const [headerB64, payloadB64, signatureB64] = parts;

            // Verify signature using Ed25519
            const signingInput = `${headerB64}.${payloadB64}`;
            const signature = Buffer.from(
                this.base64UrlToBase64(signatureB64),
                'base64',
            );

            const publicKey = crypto.createPublicKey(LICENSE_PUBLIC_KEY);
            const isValid = crypto.verify(
                null, // Ed25519 doesn't use a separate hash algorithm
                Buffer.from(signingInput),
                publicKey,
                signature,
            );

            if (!isValid) {
                this.logger.warn({
                    message: 'Invalid license key signature',
                    context: SelfHostedLicenseService.name,
                });
                return null;
            }

            const payloadJson = Buffer.from(
                this.base64UrlToBase64(payloadB64),
                'base64',
            ).toString('utf-8');

            return JSON.parse(payloadJson) as SelfHostedLicensePayload;
        } catch (error) {
            this.logger.error({
                message: 'Failed to verify/decode license JWT',
                context: SelfHostedLicenseService.name,
                error,
            });
            return null;
        }
    }

    private base64UrlToBase64(base64url: string): string {
        return base64url
            .replace(/-/g, '+')
            .replace(/_/g, '/')
            .padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), '=');
    }
}
