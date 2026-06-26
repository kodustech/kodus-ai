import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { OrgReportEmailProps } from '@libs/common/email/templates/org-report';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';

import {
    COCKPIT_REPORTS_SERVICE_TOKEN,
    ICockpitReportsService,
} from '../../domain/contracts/cockpit-reports.service.contract';
import {
    IReportRecipientsService,
    REPORT_RECIPIENTS_SERVICE_TOKEN,
} from '../../domain/contracts/report-recipients.service.contract';
import { buildCockpitLink, SendReportResult } from './report-shared';

export interface SendOrgReportInput {
    organizationId: string;
    startDate: string; // YYYY-MM-DD
    endDate: string; // YYYY-MM-DD
}

/**
 * Org-level executive report — replaces the legacy weekly recap for owners.
 * Sent monthly to active OWNERs. Skips orgs with no review activity or no
 * recipients so we never ship an empty/zeroed email.
 */
@Injectable()
export class SendOrgReportUseCase {
    private readonly logger = createLogger(SendOrgReportUseCase.name);

    private static readonly CHUNK_SIZE = 50;

    constructor(
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
        @Inject(REPORT_RECIPIENTS_SERVICE_TOKEN)
        private readonly recipients: IReportRecipientsService,
        @Inject(COCKPIT_REPORTS_SERVICE_TOKEN)
        private readonly reports: ICockpitReportsService,
        private readonly notificationService: NotificationService,
        private readonly configService: ConfigService,
    ) {}

    async execute(input: SendOrgReportInput): Promise<SendReportResult> {
        const { organizationId, startDate, endDate } = input;

        const organization = await this.organizationService.findOne({
            uuid: organizationId,
        });
        if (!organization) {
            return emptyResult(organizationId, 'org-not-found');
        }

        const owners = await this.recipients.getOwners(organizationId);
        if (owners.length === 0) {
            return emptyResult(organizationId, 'no-recipients');
        }

        const data = await this.reports.buildOrgReport(
            organizationId,
            organization.name,
            startDate,
            endDate,
        );
        if (data.reviews <= 0) {
            return emptyResult(organizationId, 'no-activity');
        }

        const baseProps: Omit<OrgReportEmailProps, 'recipientName'> = {
            company: data.company,
            startDate,
            endDate,
            reviews: data.reviews,
            reviewsTrend: data.reviewsTrend,
            reviewsChangePct: data.reviewsChangePct,
            implementationRate: data.implementationRate,
            implementationRateTrend: data.implementationRateTrend,
            implementationRatePpChange: data.implementationRatePpChange,
            suggestionsImplemented: data.suggestionsImplemented,
            criticalImplemented: data.criticalImplemented,
            prCycleTimeHours: data.prCycleTimeHours,
            prCycleTimeTrend: data.prCycleTimeTrend,
            prCycleTimeChangePct: data.prCycleTimeChangePct,
            implementationRateEvolution: data.implementationRateEvolution.map(
                (p) => ({ label: p.label, rate: p.rate }),
            ),
            repoRanking: data.repoRanking,
            highlights: data.highlights.map((h) => ({
                repository: h.repository,
                detail: h.detail,
            })),
            rulesNeedingAttention: data.rulesNeedingAttention.map((r) => ({
                title: r.title,
                triggers: r.triggers,
                implementationRate: r.implementationRate,
                thumbsDown: r.thumbsDown,
                state: r.state,
            })),
            rulesNeedingAttentionMore: data.rulesNeedingAttentionMore,
            cockpitLink: buildCockpitLink(this.configService, {
                tab: 'kodus-review',
                start: startDate,
                end: endDate,
            }),
        };

        let sent = 0;
        const failures: SendReportResult['failures'] = [];

        for (
            let i = 0;
            i < owners.length;
            i += SendOrgReportUseCase.CHUNK_SIZE
        ) {
            const chunk = owners.slice(i, i + SendOrgReportUseCase.CHUNK_SIZE);
            const results = await Promise.allSettled(
                chunk.map((r) =>
                    this.notificationService.emit({
                        event: NotificationEvent.ORG_REPORT,
                        payload: {
                            recipient: { email: r.email, name: r.name },
                            props: { recipientName: r.name, ...baseProps },
                        },
                        organizationId,
                        recipients: { kind: 'email', email: r.email },
                    }),
                ),
            );
            results.forEach((res, j) => {
                if (res.status === 'fulfilled') {
                    sent += 1;
                } else {
                    failures.push({
                        email: chunk[j].email,
                        reason:
                            res.reason instanceof Error
                                ? res.reason.message
                                : String(res.reason),
                    });
                }
            });
        }

        this.logger.log({
            message: 'Org report completed',
            context: SendOrgReportUseCase.name,
            metadata: {
                organizationId,
                organization: organization.name,
                startDate,
                endDate,
                recipientsCount: owners.length,
                sent,
                failed: failures.length,
            },
        });

        return { organizationId, sent, failed: failures.length, failures };
    }
}

function emptyResult(
    organizationId: string,
    skipped: SendReportResult['skipped'],
): SendReportResult {
    return { organizationId, skipped, sent: 0, failed: 0, failures: [] };
}
