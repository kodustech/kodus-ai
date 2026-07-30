/* eslint-disable no-console */
import 'dotenv/config';
import { randomUUID } from 'crypto';

import { ConfigService } from '@nestjs/config';

import { EmailService } from '@libs/common/email/services/email.service';
import { ResendClientProvider } from '@libs/common/email/services/resend.client';

// Standalone smoke runner for the Resend email pipeline. Sends one of each
// transactional email to RESEND_TEST_EMAIL and reports per-email status.
//
// Run with:  pnpm run email:test
//
// Required env: RESEND_API_KEY, RESEND_TEST_EMAIL, API_USER_INVITE_BASE_URL.

type Result = {
    name: string;
    ok: boolean;
    detail: string;
};

async function main() {
    const apiKey = process.env.RESEND_API_KEY;
    const recipientEmail = process.env.RESEND_TEST_EMAIL;
    const inviteUrl = process.env.API_USER_INVITE_BASE_URL;

    const missing: string[] = [];
    if (!apiKey) missing.push('RESEND_API_KEY');
    if (!recipientEmail) missing.push('RESEND_TEST_EMAIL');
    if (!inviteUrl) missing.push('API_USER_INVITE_BASE_URL');
    if (missing.length > 0) {
        console.error(`❌ Missing env: ${missing.join(', ')}`);
        process.exit(2);
    }

    const recipientName =
        process.env.RESEND_TEST_NAME ||
        recipientEmail!.split('@')[0] ||
        'Test User';
    const orgName = process.env.RESEND_TEST_ORG || 'Kodus Test Organization';
    const teamName = process.env.RESEND_TEST_TEAM || 'Kodus Test Team';
    const adminEmail =
        process.env.RESEND_TEST_ADMIN_EMAIL || recipientEmail!;
    const domain = process.env.RESEND_TEST_DOMAIN || 'acme.com';

    console.log(`📤 Sending 6 test emails to ${recipientEmail}`);
    console.log(`   from:  noreply@notifications.kodus.io`);
    console.log(`   org:   ${orgName}`);
    console.log(`   team:  ${teamName}`);
    console.log('');

    const configService = new ConfigService(process.env);
    const resendClient = new ResendClientProvider(configService);
    const emailService = new EmailService(configService, resendClient);

    const results: Result[] = [];

    const run = async (
        name: string,
        fn: () => Promise<unknown>,
    ): Promise<void> => {
        process.stdout.write(`  → ${name.padEnd(24)} `);
        try {
            const r = (await fn()) as { id?: string } | undefined;
            if (!r) {
                results.push({
                    name,
                    ok: false,
                    detail: 'returned undefined (check Resend dashboard)',
                });
                console.log('❌ undefined');
                return;
            }
            results.push({ name, ok: true, detail: `id=${r.id ?? 'n/a'}` });
            console.log(`✅ id=${r.id ?? 'n/a'}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ name, ok: false, detail: msg });
            console.log(`❌ ${msg}`);
        }
    };

    await run('forgot-password', () =>
        emailService.sendForgotPasswordEmail(
            recipientEmail!,
            recipientName,
            'preview-token-forgot-' + randomUUID(),
        ),
    );

    await run('confirmation', () =>
        emailService.sendConfirmationEmail(
            'preview-token-confirm-' + randomUUID(),
            recipientEmail!,
            orgName,
            { teamId: teamName },
        ),
    );

    await run('invite', () =>
        emailService.sendInvite(
            {
                email: recipientEmail!,
                organization: { name: orgName },
                teamMember: [{ name: recipientName, team: { name: teamName } }],
            },
            adminEmail,
            `${inviteUrl}/invite/${randomUUID()}`,
        ),
    );

    const ruleResults = await emailService.sendKodyRulesNotification(
        [{ email: recipientEmail!, name: recipientName }],
        [
            'All public methods should have unit tests covering happy path and edge cases.',
            'API endpoints must include OpenAPI/Swagger documentation.',
            'Avoid logging PII in info/debug levels.',
            'Wrap async operations in try/catch and surface meaningful error messages.',
        ],
        orgName,
    );
    const ruleFailures = ruleResults.filter((r) => r.status === 'rejected');
    if (ruleFailures.length > 0) {
        const reasons = ruleFailures
            .map((f) => (f as PromiseRejectedResult).reason?.message)
            .join('; ');
        results.push({
            name: 'kody-rules',
            ok: false,
            detail: reasons || 'unknown',
        });
        console.log(`  → kody-rules${' '.repeat(13)} ❌ ${reasons}`);
    } else {
        const ok = ruleResults[0] as PromiseFulfilledResult<{ id?: string }>;
        results.push({
            name: 'kody-rules',
            ok: true,
            detail: `id=${ok.value?.id ?? 'n/a'}`,
        });
        console.log(`  → kody-rules${' '.repeat(13)} ✅ id=${ok.value?.id ?? 'n/a'}`);
    }

    await run('domain-verification', () =>
        emailService.sendDomainVerificationEmail(
            'preview-token-domain-' + randomUUID(),
            recipientEmail!,
            orgName,
            domain,
        ),
    );

    await run('weekly-recap', () =>
        emailService.sendWeeklyRecap(
            { email: recipientEmail!, name: recipientName },
            {
                company: orgName,
                startDate: '2026-04-19',
                endDate: '2026-04-25',
                numPRs: 42,
                reviewedPRs: 42,
                kodySuggestions: 188,
                suggestionsApplied: 73,
                criticalIssues: 6,
                bugRatio: 0.12,
                bugRatioTrend: 'improved',
                bugRatioChangePct: -18,
                deployFrequency: 18,
                deployFrequencyTrend: 'improved',
                deployFrequencyChangePct: 22,
                prCycleTime: 9.4,
                prCycleTimeTrend: 'improved',
                prCycleTimeChangePct: -12,
                reviewTime: 2.1,
                topContributorName: recipientName,
                topContributorPRs: 12,
                companyRank: 5,
                companyRankPercentile: 4.2,
                companyRankBarFill: 96,
                showRanking: true,
                topAnalysisTypes: [
                    { category: 'Code quality', count: 64 },
                    { category: 'Security', count: 31 },
                    { category: 'Performance', count: 22 },
                ],
                cockpitLink: `${
                    process.env.API_USER_INVITE_BASE_URL ?? 'https://app.kodus.io'
                }/cockpit`,
            },
        ),
    );

    console.log('');
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
        console.log(`✅ All ${results.length} emails accepted by Resend.`);
        console.log(`   Check ${recipientEmail} (and Resend dashboard).`);
        process.exit(0);
    } else {
        console.log(`❌ ${failed.length} of ${results.length} failed:`);
        failed.forEach((f) => console.log(`   - ${f.name}: ${f.detail}`));
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
