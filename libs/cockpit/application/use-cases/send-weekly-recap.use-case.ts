import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { WeeklyRecapEmailProps } from '@libs/common/email/templates/weekly-recap';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';

import { CockpitDeveloperProductivityService } from '../../infrastructure/services/cockpit-developer-productivity.service';

export type WeeklyRecapInput = {
    organizationId: string;
    startDate: string; // YYYY-MM-DD
    endDate: string; // YYYY-MM-DD
};

export type WeeklyRecapResult = {
    organizationId: string;
    skipped?: 'no-prs' | 'no-recipients' | 'org-not-found';
    sent: number;
    failed: number;
    failures: Array<{ email: string; reason?: string }>;
};

@Injectable()
export class SendWeeklyRecapUseCase {
    private readonly logger = createLogger(SendWeeklyRecapUseCase.name);

    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
        private readonly productivity: CockpitDeveloperProductivityService,
        private readonly notificationService: NotificationService,
        private readonly configService: ConfigService,
    ) {}

    async execute(input: WeeklyRecapInput): Promise<WeeklyRecapResult> {
        const { organizationId, startDate, endDate } = input;

        const organization = await this.organizationService.findOne({
            uuid: organizationId,
        });
        if (!organization) {
            this.logger.warn({
                message: 'Weekly recap skipped: org not found',
                context: SendWeeklyRecapUseCase.name,
                metadata: { organizationId },
            });
            return {
                organizationId,
                skipped: 'org-not-found',
                sent: 0,
                failed: 0,
                failures: [],
            };
        }

        const dashboard =
            await this.productivity.getCompanyDashboardInsights({
                organizationId,
                startDate,
                endDate,
            });

        if (dashboard.metrics.totalPRs <= 0) {
            this.logger.log({
                message:
                    'Weekly recap skipped: no PRs reviewed in window',
                context: SendWeeklyRecapUseCase.name,
                metadata: { organizationId, startDate, endDate },
            });
            return {
                organizationId,
                skipped: 'no-prs',
                sent: 0,
                failed: 0,
                failures: [],
            };
        }

        const users = await this.usersService.find(
            { organization: { uuid: organizationId }, role: Role.OWNER },
            [STATUS.ACTIVE],
        );
        if (!users || users.length === 0) {
            return {
                organizationId,
                skipped: 'no-recipients',
                sent: 0,
                failed: 0,
                failures: [],
            };
        }

        const recipients = users
            .filter((u) => Boolean(u?.email))
            .map((u) => ({
                email: u.email,
                name: this.resolveDisplayName(u),
            }));

        if (recipients.length === 0) {
            return {
                organizationId,
                skipped: 'no-recipients',
                sent: 0,
                failed: 0,
                failures: [],
            };
        }

        const props = this.mapDashboardToEmailProps(
            organization.name,
            startDate,
            endDate,
            dashboard,
        );

        let sent = 0;
        const failures: WeeklyRecapResult['failures'] = [];
        // Emit notifications per recipient via the notification engine.
        // The dispatcher handles channel routing and delivery.
        const CHUNK_SIZE = 50;
        for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
            const chunk = recipients.slice(i, i + CHUNK_SIZE);
            const results = await Promise.allSettled(
                chunk.map((r) =>
                    this.notificationService.emit({
                        event: NotificationEvent.WEEKLY_RECAP,
                        payload: {
                            recipient: { email: r.email, name: r.name },
                            props,
                        },
                        organizationId,
                        recipients: { kind: 'email', email: r.email },
                    }),
                ),
            );

            results.forEach((r, j) => {
                const email = chunk[j].email;
                if (r.status === 'fulfilled') {
                    sent += 1;
                } else {
                    failures.push({
                        email,
                        reason:
                            r.reason instanceof Error
                                ? r.reason.message
                                : String(r.reason),
                    });
                }
            });
        }

        this.logger.log({
            message: 'Weekly recap completed',
            context: SendWeeklyRecapUseCase.name,
            metadata: {
                organizationId,
                organization: organization.name,
                startDate,
                endDate,
                recipientsCount: recipients.length,
                sent,
                failed: failures.length,
            },
        });

        return {
            organizationId,
            sent,
            failed: failures.length,
            failures,
        };
    }

    private resolveDisplayName(user: any): string {
        const teamName = user?.teamMember?.[0]?.name;
        if (typeof teamName === 'string' && teamName.trim()) {
            return teamName.trim().split(/\s+/)[0];
        }
        if (typeof user?.email === 'string') {
            return user.email.split('@')[0];
        }
        return 'there';
    }

    private mapDashboardToEmailProps(
        company: string,
        startDate: string,
        endDate: string,
        dashboard: Awaited<
            ReturnType<
                CockpitDeveloperProductivityService['getCompanyDashboardInsights']
            >
        >,
    ): Omit<WeeklyRecapEmailProps, 'devName'> {
        const reviewedPRs = dashboard.metrics.totalPRs;
        const kodySuggestions = dashboard.metrics.totalSuggestions;
        const criticalIssues = dashboard.metrics.criticalSuggestions;
        const companyRank = dashboard.metrics.companyRanking.rank;
        const totalCompanies =
            dashboard.metrics.companyRanking.totalCompanies;
        // Percentile bucket (1 = #1, 50 = median). Kept independent of
        // `totalCompanies` so the email never has to expose the network
        // size — small networks shouldn't read as "you're #5 of 5".
        const companyRankPercentile =
            totalCompanies > 0 && companyRank > 0
                ? (companyRank / totalCompanies) * 100
                : 100;
        // Bar fill is intentionally NOT `100 - percentile`: that would give
        // an empty bar for #1 of 1 (percentile=100). Use rank-inverted so
        // #1 always reads as "max bar".
        const companyRankBarFill =
            totalCompanies > 0 && companyRank > 0
                ? Math.max(
                      4,
                      ((totalCompanies - companyRank + 1) / totalCompanies) *
                          100,
                  )
                : 0;
        // Suppress the ranking hero when there's no real comparison set
        // (self-hosted: only 1 org in the warehouse, or org alone in the
        // window). Avoids hollow "🥇 Top performer #1" out of context.
        const showRanking = totalCompanies > 1 && companyRank > 0;

        const suggestionsApplied =
            dashboard.additionalMetrics.suggestionsImplementedCount ?? 0;

        // currentPeriod.ratio is already a percentage (e.g. 17.51), but the
        // template's `bugRatio` prop is contracted as 0..1 and multiplies by
        // 100 again — pass the fraction here to honour that contract.
        const bugRatio =
            (dashboard.additionalMetrics.bugRatio?.currentPeriod.ratio ?? 0) /
            100;
        const bugRatioTrend =
            dashboard.additionalMetrics.bugRatio?.comparison.trend ??
            'unchanged';
        const bugRatioChangePct =
            dashboard.additionalMetrics.bugRatio?.comparison.percentageChange ??
            0;

        const deployFrequency =
            dashboard.additionalMetrics.deployFrequency?.currentPeriod
                .totalDeployments ?? 0;
        const deployFrequencyTrend =
            dashboard.additionalMetrics.deployFrequency?.comparison.trend ??
            'unchanged';
        const deployFrequencyChangePct =
            dashboard.additionalMetrics.deployFrequency?.comparison
                .percentageChange ?? 0;

        const prCycleTime =
            dashboard.additionalMetrics.cycleTime?.currentPeriod
                .leadTimeP75Hours ?? 0;
        const prCycleTimeTrend =
            dashboard.additionalMetrics.cycleTime?.comparison.trend ??
            'unchanged';
        const prCycleTimeChangePct =
            dashboard.additionalMetrics.cycleTime?.comparison.percentageChange ??
            0;

        const breakdown =
            dashboard.additionalMetrics.leadTimeBreakdown ?? [];
        const reviewTime =
            breakdown.length > 0
                ? breakdown.reduce(
                      (acc, w) => acc + (w.reviewTimeHours ?? 0),
                      0,
                  ) / breakdown.length
                : 0;

        const topContributorName =
            dashboard.metrics.topDeveloper?.name ?? '';
        const topContributorPRs =
            dashboard.metrics.topDeveloper?.totalPRs ?? 0;

        const cockpitLink = this.buildCockpitLink();

        return {
            company,
            startDate,
            endDate,
            numPRs: reviewedPRs,
            reviewedPRs,
            kodySuggestions,
            suggestionsApplied,
            criticalIssues,
            bugRatio,
            bugRatioTrend,
            bugRatioChangePct,
            deployFrequency,
            deployFrequencyTrend,
            deployFrequencyChangePct,
            prCycleTime,
            prCycleTimeTrend,
            prCycleTimeChangePct,
            reviewTime,
            topContributorName,
            topContributorPRs,
            companyRank,
            companyRankPercentile,
            companyRankBarFill,
            showRanking,
            topAnalysisTypes: dashboard.metrics.topSuggestionsCategories.slice(
                0,
                3,
            ),
            cockpitLink,
        };
    }

    private buildCockpitLink(): string {
        const base =
            this.configService.get<string>('API_USER_INVITE_BASE_URL') ?? '';
        return base ? `${base.replace(/\/$/, '')}/cockpit` : 'https://app.kodus.io/cockpit';
    }
}
