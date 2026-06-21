import * as crypto from 'crypto';
import { createLogger } from '@kodus/flow';
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
} from './interfaces/license.interface';

// Ed25519 public key used to verify self-hosted license JWTs.
// This is the public half of the keypair held by Kodus for signing licenses.
const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAig1JYVU3PCPOY18JGKsMdcoPeDMrGRCRb5XPZeLniZc=
-----END PUBLIC KEY-----`;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class SelfHostedLicenseService implements ILicenseService {
    private readonly logger = createLogger(SelfHostedLicenseService.name);

    private cache: {
        result: OrganizationLicenseValidationResult;
        expiresAt: number;
    } | null = null;

    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    async validateOrganizationLicense(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationLicenseValidationResult> {
        // Return cached result if still valid
        if (this.cache && Date.now() < this.cache.expiresAt) {
            return this.cache.result;
        }

        try {
            const token = await this.getLicenseKey(organizationAndTeamData);

            if (!token) {
                return { valid: false };
            }

            const payload = this.verifyAndDecode(token);

            if (!payload) {
                return { valid: false };
            }

            // Check expiration
            const now = Math.floor(Date.now() / 1000);
            if (payload.exp && payload.exp < now) {
                this.logger.warn({
                    message: 'Self-hosted license key has expired',
                    context: SelfHostedLicenseService.name,
                    metadata: {
                        expiredAt: new Date(payload.exp * 1000).toISOString(),
                    },
                });
                return {
                    valid: false,
                    subscriptionStatus: SubscriptionStatus.EXPIRED,
                };
            }

            const result: OrganizationLicenseValidationResult = {
                valid: true,
                subscriptionStatus: SubscriptionStatus.LICENSED_SELF_HOSTED,
                planType: payload.plan,
                numberOfLicenses: payload.seats,
                expiresAt: new Date(payload.exp * 1000).toISOString(),
            };

            this.cache = {
                result,
                expiresAt: Date.now() + CACHE_TTL_MS,
            };

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error validating self-hosted license',
                context: SelfHostedLicenseService.name,
                error,
            });
            return { valid: false };
        }
    }

    async getAllUsersWithLicense(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<UserWithLicense[]> {
        try {
            const assignedUsers = await this.getAssignedUsers(
                organizationAndTeamData,
            );
            return assignedUsers.map((gitId) => ({ git_id: gitId }));
        } catch (error) {
            this.logger.error({
                message: 'Error getting assigned users',
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

            // Already assigned
            if (assignedUsers.includes(userGitId)) {
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

            assignedUsers.push(userGitId);
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
        try {
            const assignedUsers = await this.getAssignedUsers(
                organizationAndTeamData,
            );
            const filtered = assignedUsers.filter((id) => id !== userGitId);

            if (filtered.length === assignedUsers.length) {
                return true; // User wasn't assigned
            }

            await this.saveAssignedUsers(organizationAndTeamData, filtered);
            return true;
        } catch (error) {
            this.logger.error({
                message: 'Error unassigning license',
                context: SelfHostedLicenseService.name,
                error,
            });
            return false;
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

    private async getAssignedUsers(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string[]> {
        try {
            const param = await this.organizationParametersService.findByKey(
                OrganizationParametersKey.LICENSE_ASSIGNED_USERS,
                organizationAndTeamData,
            );
            if (
                param?.configValue?.users &&
                Array.isArray(param.configValue.users)
            ) {
                return param.configValue.users;
            }
        } catch {
            // Not found yet
        }
        return [];
    }

    private async saveAssignedUsers(
        organizationAndTeamData: OrganizationAndTeamData,
        users: string[],
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
                const users = param.configValue?.users;
                if (Array.isArray(users)) {
                    for (const user of users) {
                        uniqueUsers.add(user);
                    }
                }
            }

            return uniqueUsers.size;
        } catch {
            return 0;
        }
    }

    /**
     * Decode and validate the license key without checking expiration.
     * Useful for the status endpoint that needs to show details even for expired keys.
     */
    decodePayload(token: string): SelfHostedLicensePayload | null {
        return this.verifyAndDecode(token);
    }

    /**
     * Clear the in-memory cache (e.g., after activating a new key).
     */
    clearCache(): void {
        this.cache = null;
    }

    private async getLicenseKey(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string | null> {
        // Try DB first
        try {
            const param = await this.organizationParametersService.findByKey(
                OrganizationParametersKey.LICENSE_KEY,
                organizationAndTeamData,
            );

            if (param?.configValue) {
                const raw =
                    typeof param.configValue === 'string'
                        ? param.configValue
                        : param.configValue.key;
                return raw ? raw.replace(/\s+/g, '') : null;
            }
        } catch {
            // DB lookup failed, fall through to env var
        }

        // Fallback to env var. KODUS_LICENSE_KEY is the customer-facing
        // name self-hosted installs use — do NOT rename it (our test
        // provisioning must set this exact var).
        return process.env.KODUS_LICENSE_KEY || null;
    }

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
