import { NotificationEvent } from '../../../domain/catalog/events';
import { IN_APP_TEMPLATE_REGISTRY } from './in-app-template.registry';

describe('IN_APP_TEMPLATE_REGISTRY', () => {
    /**
     * Representative payloads — minimum fields the registered builders
     * need to render without throwing. Specific event tests below
     * assert the more interesting per-event behaviour (CTA url, count
     * pluralization, etc.).
     */
    const PAYLOADS: Partial<Record<NotificationEvent, Record<string, unknown>>> = {
        [NotificationEvent.AUTH_EMAIL_CONFIRMATION]: {
            organizationName: 'Acme',
        },
        [NotificationEvent.AUTH_FORGOT_PASSWORD]: {},
        [NotificationEvent.TEAM_MEMBER_INVITED]: {},
        [NotificationEvent.KODY_RULES_GENERATED]: {
            organizationName: 'Acme',
        },
        [NotificationEvent.SSO_DOMAIN_VERIFICATION]: { domain: 'acme.com' },
        [NotificationEvent.WEEKLY_RECAP]: {},
        [NotificationEvent.REVIEW_AUTO_APPROVED]: {
            repoName: 'acme/api',
            prUrl: 'https://github.com/acme/api/pull/1',
        },
        [NotificationEvent.REVIEW_FAILED]: {
            repoName: 'acme/api',
            reason: 'timeout',
            prUrl: 'https://github.com/acme/api/pull/1',
        },
        [NotificationEvent.REVIEW_SKIPPED_NO_LICENSE]: {
            repoName: 'acme/api',
            prUrl: 'https://github.com/acme/api/pull/1',
            ownerContact: 'owner@acme.com',
        },
        [NotificationEvent.IDE_RULES_SYNCED]: {
            repoName: 'acme/api',
            rulesCount: 12,
        },
        [NotificationEvent.IDE_RULES_SYNC_FAILED]: {
            repoName: 'acme/api',
            reason: 'auth failed',
        },
        [NotificationEvent.ORG_MEMBER_REMOVED]: {
            removedUser: { name: 'Alex', email: 'alex@a.com' },
            organizationName: 'Acme',
        },
        [NotificationEvent.ORG_ROLE_CHANGED]: {
            previousRole: 'contributor',
            newRole: 'owner',
            organizationName: 'Acme',
        },
        [NotificationEvent.BILLING_PAYMENT_FAILED]: {
            amount: 2400,
            currency: 'usd',
            failureReason: 'Card declined',
            updatePaymentUrl: 'https://app.kodus.io/billing',
        },
        [NotificationEvent.BILLING_TRIAL_EXPIRING]: {
            daysRemaining: 7,
            trialEndsAt: '2026-03-12T00:00:00Z',
            upgradeUrl: 'https://app.kodus.io/billing',
        },
        [NotificationEvent.BYOK_LLM_ERRORS_THRESHOLD]: {
            provider: 'anthropic',
            errorCount: 14,
            windowStart: '2026-03-05T14:00:00Z',
            windowEnd: '2026-03-05T15:00:00Z',
            sampleError: 'Rate limit exceeded',
        },
        [NotificationEvent.RULE_FILE_REFERENCES_INVALID]: {
            source: 'manual',
            repoName: 'acme/api',
            invalidCount: 3,
            issues: [
                {
                    ruleId: 'r-1',
                    ruleName: 'No console.log',
                    filePath: 'src/logger.ts',
                    reason: 'File not found',
                },
            ],
        },
    };

    it('has a builder registered for every event in NotificationEvent enum', () => {
        for (const event of Object.values(NotificationEvent)) {
            expect(IN_APP_TEMPLATE_REGISTRY[event]).toBeDefined();
        }
    });

    it.each(Object.values(NotificationEvent))(
        '%s: builder returns a non-empty title/body',
        (event) => {
            const builder = IN_APP_TEMPLATE_REGISTRY[event]!;
            const result = builder(PAYLOADS[event] ?? {});
            expect(result.title).toEqual(expect.any(String));
            expect(result.title.length).toBeGreaterThan(0);
            expect(result.body).toEqual(expect.any(String));
            expect(result.body.length).toBeGreaterThan(0);
        },
    );

    describe('review.auto_approved', () => {
        it('exposes prUrl as the CTA', () => {
            const result = IN_APP_TEMPLATE_REGISTRY[
                NotificationEvent.REVIEW_AUTO_APPROVED
            ]!({
                repoName: 'acme/api',
                prUrl: 'https://github.com/acme/api/pull/42',
            });
            expect(result.ctaUrl).toBe(
                'https://github.com/acme/api/pull/42',
            );
        });
    });

    describe('ide.rules_synced', () => {
        it('pluralizes "rule" vs "rules" based on rulesCount', () => {
            const one = IN_APP_TEMPLATE_REGISTRY[
                NotificationEvent.IDE_RULES_SYNCED
            ]!({ repoName: 'r', rulesCount: 1 });
            const many = IN_APP_TEMPLATE_REGISTRY[
                NotificationEvent.IDE_RULES_SYNCED
            ]!({ repoName: 'r', rulesCount: 7 });

            expect(one.body).toContain('1 rule synced');
            expect(many.body).toContain('7 rules synced');
        });
    });

    describe('org.member_removed', () => {
        it('falls back to email when no name is provided', () => {
            const result = IN_APP_TEMPLATE_REGISTRY[
                NotificationEvent.ORG_MEMBER_REMOVED
            ]!({
                removedUser: { email: 'x@y.com' },
                organizationName: 'Acme',
            });
            expect(result.body).toContain('x@y.com');
        });
    });
});
