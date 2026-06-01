import { randomUUID } from 'crypto';

import { createLogger } from '@kodus/flow';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { CacheService } from '@libs/core/cache/cache.service';
import { environment } from '@libs/ee/configs/environment';
import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';

import { SSODomainVerificationRecord } from '../domain/interfaces/ssoConfig.interface';
import { normalizeDomains } from '../utils/sso-fingerprint.util';

const DOMAIN_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const DOMAIN_VERIFICATION_STATUS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_KEY_PREFIX = 'sso:domain-verification:token';
const STATUS_KEY_PREFIX = 'sso:domain-verification:status';

interface PendingDomainVerificationToken {
    token: string;
    organizationId: string;
    organizationName: string;
    domain: string;
    contactEmail: string;
    requestedBy?: string;
    createdAt: string;
}

@Injectable()
export class SSODomainVerificationService {
    private readonly logger = createLogger(SSODomainVerificationService.name);

    constructor(
        private readonly cacheService: CacheService,
        private readonly notificationService: NotificationService,
    ) {}

    private tokenKey(token: string): string {
        return `${TOKEN_KEY_PREFIX}:${token}`;
    }

    private statusKey(organizationId: string, domain: string): string {
        return `${STATUS_KEY_PREFIX}:${organizationId}:${domain}`;
    }

    normalizeDomain(domain: string): string {
        return normalizeDomains([domain])[0];
    }

    private assertDomainContactEmail(
        domain: string,
        contactEmail: string,
        options: { requireDomainMatch?: boolean } = {},
    ): void {
        const { requireDomainMatch = true } = options;
        const normalizedDomain = this.normalizeDomain(domain);
        const normalizedEmail = String(contactEmail || '')
            .trim()
            .toLowerCase();

        if (!normalizedDomain) {
            throw new BadRequestException('Domain is required');
        }

        if (
            !normalizedEmail ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
        ) {
            throw new BadRequestException('A valid contact email is required');
        }

        // Cloud only: prove the requester controls email at the domain by
        // requiring the contact to live at it (we'll actually send a
        // verification link there). In self-hosted there's no email
        // handshake, so the address is just audit metadata — admins
        // legitimately want to use their own work email even when the
        // SSO domain belongs to a different brand they manage.
        if (
            requireDomainMatch &&
            !normalizedEmail.endsWith(`@${normalizedDomain}`)
        ) {
            throw new BadRequestException(
                'The contact email must belong to the domain being verified.',
            );
        }
    }

    async requestDomainVerification(params: {
        organizationId: string;
        organizationName: string;
        domain: string;
        contactEmail: string;
        requestedBy?: string;
    }) {
        const normalizedDomain = this.normalizeDomain(params.domain);
        const normalizedEmail = String(params.contactEmail || '')
            .trim()
            .toLowerCase();

        this.assertDomainContactEmail(normalizedDomain, normalizedEmail, {
            requireDomainMatch: environment.API_CLOUD_MODE,
        });

        // Self-hosted skip: in self-hosted mode the deployment is
        // single-tenant and the admin already controls the box (DB,
        // secrets, SSH). Asking them to prove they control email at the
        // domain via an out-of-band Resend/Customer.io handshake adds
        // no real security but blocks SSO setup behind a SaaS email
        // provider they may not want to configure. Mirrors the email-
        // confirmation skip in join-organization.use-case.ts.
        if (!environment.API_CLOUD_MODE) {
            const record: SSODomainVerificationRecord = {
                domain: normalizedDomain,
                verifiedByEmail: normalizedEmail,
                verifiedAt: new Date(),
            };

            await this.cacheService.addToCache(
                this.statusKey(params.organizationId, normalizedDomain),
                record,
                DOMAIN_VERIFICATION_STATUS_TTL_MS,
            );

            this.logger.log({
                message: 'SSO domain auto-verified (self-hosted mode)',
                context: SSODomainVerificationService.name,
                serviceName: SSODomainVerificationService.name,
                metadata: {
                    organizationId: params.organizationId,
                    domain: normalizedDomain,
                    contactEmail: normalizedEmail,
                    requestedBy: params.requestedBy,
                },
            });

            return {
                domain: normalizedDomain,
                contactEmail: normalizedEmail,
                sent: false,
            };
        }

        const token = randomUUID();
        const payload: PendingDomainVerificationToken = {
            token,
            organizationId: params.organizationId,
            organizationName: params.organizationName,
            domain: normalizedDomain,
            contactEmail: normalizedEmail,
            requestedBy: params.requestedBy,
            createdAt: new Date().toISOString(),
        };

        await this.cacheService.addToCache(
            this.tokenKey(token),
            payload,
            DOMAIN_VERIFICATION_TOKEN_TTL_MS,
        );

        await this.notificationService.emit({
            event: NotificationEvent.SSO_DOMAIN_VERIFICATION,
            payload: {
                token,
                email: normalizedEmail,
                organizationName: params.organizationName,
                domain: normalizedDomain,
            },
            organizationId: params.organizationId,
            // The contact email may not yet be a registered user (the
            // whole point of the flow), so address by email and let the
            // dispatcher fall back to email-only delivery if needed.
            recipients: { kind: 'email', email: normalizedEmail },
        });

        return {
            domain: normalizedDomain,
            contactEmail: normalizedEmail,
            sent: true,
        };
    }

    async confirmDomainVerification(
        token: string,
    ): Promise<SSODomainVerificationRecord> {
        const payload =
            await this.cacheService.getFromCache<PendingDomainVerificationToken>(
                this.tokenKey(token),
            );

        if (!payload) {
            throw new NotFoundException({
                message: 'Domain verification token not found or expired.',
                code: 'SSO_DOMAIN_VERIFICATION_TOKEN_INVALID',
            });
        }

        const record: SSODomainVerificationRecord = {
            domain: payload.domain,
            verifiedByEmail: payload.contactEmail,
            verifiedAt: new Date(),
        };

        await this.cacheService.addToCache(
            this.statusKey(payload.organizationId, payload.domain),
            record,
            DOMAIN_VERIFICATION_STATUS_TTL_MS,
        );

        await this.cacheService.removeFromCache(this.tokenKey(token));

        return record;
    }

    async getDomainVerificationStatus(params: {
        organizationId: string;
        domain: string;
    }): Promise<SSODomainVerificationRecord | null> {
        const domain = this.normalizeDomain(params.domain);

        if (!domain) {
            return null;
        }

        return this.cacheService.getFromCache<SSODomainVerificationRecord>(
            this.statusKey(params.organizationId, domain),
        );
    }

    async getDomainsVerificationStatus(params: {
        organizationId: string;
        domains: string[];
    }) {
        const uniqueDomains = [
            ...new Set(normalizeDomains(params.domains || [])),
        ];

        const entries = await Promise.all(
            uniqueDomains.map(async (domain) => {
                const record = await this.getDomainVerificationStatus({
                    organizationId: params.organizationId,
                    domain,
                });

                return {
                    domain,
                    verified: Boolean(record),
                    verifiedAt: record?.verifiedAt,
                    verifiedByEmail: record?.verifiedByEmail,
                };
            }),
        );

        return entries;
    }
}
