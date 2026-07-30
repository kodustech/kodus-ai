import { NotificationEvent } from '../../../domain/catalog/events';
import { EMAIL_TEMPLATE_REGISTRY } from './email-template.registry';

describe('EMAIL_TEMPLATE_REGISTRY', () => {
    const CTX = { webUrl: 'https://app.example.com' };

    /**
     * Representative payloads — minimum fields the email builders need.
     * SYSTEM-only events that aren't email-bearing are excluded.
     */
    const EMAIL_PAYLOADS: Partial<Record<NotificationEvent, Record<string, unknown>>> = {
        [NotificationEvent.AUTH_EMAIL_CONFIRMATION]: {
            token: 't',
            organizationName: 'Acme',
        },
        [NotificationEvent.AUTH_FORGOT_PASSWORD]: { token: 't' },
        [NotificationEvent.TEAM_MEMBER_INVITED]: {
            user: { teamMember: [{ name: 'Alex', team: { name: 'Engineering' } }] },
            inviterEmail: 'jane@acme.com',
            inviteLink: 'https://example.com/i/x',
        },
        [NotificationEvent.KODY_RULES_GENERATED]: {
            rules: ['rule-a', 'rule-b'],
            organizationName: 'Acme',
        },
        [NotificationEvent.SSO_DOMAIN_VERIFICATION]: {
            token: 't',
            domain: 'acme.com',
            organizationName: 'Acme',
        },
        [NotificationEvent.ORG_REPORT]: {
            props: {
                recipientName: 'David',
                company: 'Acme',
                startDate: '2026-05-01',
                endDate: '2026-05-31',
                reviews: 100,
                reviewsTrend: 'improved',
                reviewsChangePct: 10,
                implementationRate: 0.46,
                implementationRateTrend: 'improved',
                implementationRatePpChange: 4,
                suggestionsImplemented: 120,
                criticalImplemented: 7,
                prCycleTimeHours: 20,
                prCycleTimeTrend: 'improved',
                prCycleTimeChangePct: -5,
                implementationRateEvolution: [],
                repoRanking: [],
                highlights: [],
                rulesNeedingAttention: [],
                rulesNeedingAttentionMore: 0,
                cockpitLink: 'https://app.kodus.io/cockpit',
            },
        },
        [NotificationEvent.REPO_REPORT]: {
            props: {
                recipientName: 'Sam',
                company: 'Acme',
                startDate: '2026-06-01',
                endDate: '2026-06-15',
                sections: [],
                cockpitLink: 'https://app.kodus.io/cockpit',
            },
        },
        [NotificationEvent.ORG_MEMBER_REMOVED]: {
            removedUser: { name: 'Alex', email: 'alex@a.com' },
            organizationName: 'Acme',
            removedBy: 'jane@acme.com',
        },
        [NotificationEvent.REVIEW_FAILED]: {
            prUrl: 'https://github.com/acme/api/pull/1',
            repoName: 'acme/api',
            reason: 'timeout',
            correlationId: 'c-1',
        },
        [NotificationEvent.IDE_RULES_SYNC_FAILED]: {
            repoName: 'acme/api',
            reason: 'permission denied',
            correlationId: 'c-1',
        },
        [NotificationEvent.BILLING_PAYMENT_FAILED]: {
            amount: 2400,
            currency: 'usd',
            failureReason: 'Card declined',
            nextRetryAt: '2026-03-05T00:00:00Z',
            updatePaymentUrl: 'https://app.kodus.io/billing',
        },
        [NotificationEvent.BILLING_TRIAL_EXPIRING]: {
            daysRemaining: 1,
            trialEndsAt: '2026-03-05T00:00:00Z',
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
            invalidCount: 1,
            issues: [
                {
                    ruleId: 'r-1',
                    ruleName: 'No console.log',
                    filePath: 'src/logger.ts',
                    reason: 'File not found',
                },
            ],
        },
        [NotificationEvent.REVIEW_AUTO_APPROVED]: {
            prUrl: 'https://github.com/acme/api/pull/1',
            repoName: 'acme/api',
        },
        [NotificationEvent.REVIEW_SKIPPED_NO_LICENSE]: {
            prUrl: 'https://github.com/acme/api/pull/1',
            repoName: 'acme/api',
            ownerContact: 'owner@acme.com',
            authorUsername: 'kodus',
        },
        [NotificationEvent.IDE_RULES_SYNCED]: {
            repoName: 'acme/api',
            rulesCount: 12,
        },
        [NotificationEvent.ORG_ROLE_CHANGED]: {
            affectedUserEmail: 'alex@acme.com',
            previousRole: 'contributor',
            newRole: 'repo_admin',
            organizationName: 'Acme',
            changedBy: 'jane@acme.com',
        },
    };

    it.each(Object.keys(EMAIL_PAYLOADS) as NotificationEvent[])(
        '%s: builder returns from/subject/react',
        (event) => {
            const builder = EMAIL_TEMPLATE_REGISTRY[event]!;
            expect(builder).toBeDefined();

            const result = builder(EMAIL_PAYLOADS[event]!, CTX);
            expect(result.from).toEqual(
                expect.objectContaining({ email: expect.any(String) }),
            );
            expect(typeof result.subject).toBe('string');
            expect(result.subject.length).toBeGreaterThan(0);
            expect(result.react).toBeTruthy();
        },
    );

    describe('REVIEW_FAILED', () => {
        it('threads repoName into the subject so admins can filter their inbox', () => {
            const result = EMAIL_TEMPLATE_REGISTRY[
                NotificationEvent.REVIEW_FAILED
            ]!(EMAIL_PAYLOADS[NotificationEvent.REVIEW_FAILED]!, CTX);
            expect(result.subject).toContain('acme/api');
        });
    });

    describe('ORG_MEMBER_REMOVED', () => {
        it('threads organizationName into the subject', () => {
            const result = EMAIL_TEMPLATE_REGISTRY[
                NotificationEvent.ORG_MEMBER_REMOVED
            ]!(EMAIL_PAYLOADS[NotificationEvent.ORG_MEMBER_REMOVED]!, CTX);
            expect(result.subject).toContain('Acme');
        });
    });
});
