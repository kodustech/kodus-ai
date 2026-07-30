import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RepoReportEmailProps } from '@libs/common/email/templates/repo-report';
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

export interface SendRepoReportInput {
    organizationId: string;
    startDate: string; // YYYY-MM-DD
    endDate: string; // YYYY-MM-DD
}

/**
 * Per-repo digest for repo admins. One email per admin, with a section for
 * each repo they administer that had activity in the window. An admin whose
 * repos were all quiet receives nothing — the digest never carries empty
 * sections.
 */
@Injectable()
export class SendRepoReportUseCase {
    private readonly logger = createLogger(SendRepoReportUseCase.name);

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

    async execute(input: SendRepoReportInput): Promise<SendReportResult> {
        const { organizationId, startDate, endDate } = input;

        const organization = await this.organizationService.findOne({
            uuid: organizationId,
        });
        if (!organization) {
            return emptyResult(organizationId, 'org-not-found');
        }

        const admins = await this.recipients.getRepoAdmins(organizationId);
        if (admins.length === 0) {
            return emptyResult(organizationId, 'no-recipients');
        }

        const deeplink = (repository?: string) =>
            buildCockpitLink(this.configService, {
                tab: 'kodus-review',
                start: startDate,
                end: endDate,
                repository,
            });

        // Build each repo's section ONCE across all admins — a repo
        // administered by N admins would otherwise be queried N times. The
        // service builds in bounded batches, so this stays O(unique repos)
        // instead of O(admins × repos) and never floods the warehouse pool.
        const uniqueRepos = [
            ...new Set(admins.flatMap((a) => a.repositories)),
        ];
        const sections = await this.reports.buildRepoSections(
            organizationId,
            uniqueRepos,
            startDate,
            endDate,
        );
        const sectionByRepo = new Map(sections.map((s) => [s.repository, s]));

        // Assemble each admin's digest from the shared sections, dropping
        // admins whose repos were all quiet.
        const digests = admins
            .map((admin) => {
                const adminSections = admin.repositories
                    .map((repo) => sectionByRepo.get(repo))
                    .filter((s): s is NonNullable<typeof s> => s !== undefined)
                    // Each section deep-links to its own repo + the window.
                    .map((s) => ({ ...s, cockpitLink: deeplink(s.repository) }));
                if (adminSections.length === 0) {
                    return null;
                }
                const props: RepoReportEmailProps = {
                    recipientName: admin.name,
                    company: organization.name,
                    startDate,
                    endDate,
                    sections: adminSections,
                    cockpitLink: deeplink(),
                };
                return { email: admin.email, name: admin.name, props };
            })
            .filter((d): d is NonNullable<typeof d> => d !== null);

        if (digests.length === 0) {
            return emptyResult(organizationId, 'no-activity');
        }

        let sent = 0;
        const failures: SendReportResult['failures'] = [];

        for (
            let i = 0;
            i < digests.length;
            i += SendRepoReportUseCase.CHUNK_SIZE
        ) {
            const chunk = digests.slice(
                i,
                i + SendRepoReportUseCase.CHUNK_SIZE,
            );
            const results = await Promise.allSettled(
                chunk.map((d) =>
                    this.notificationService.emit({
                        event: NotificationEvent.REPO_REPORT,
                        payload: {
                            recipient: { email: d.email, name: d.name },
                            props: d.props as unknown as Record<
                                string,
                                unknown
                            >,
                        },
                        organizationId,
                        recipients: { kind: 'email', email: d.email },
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
            message: 'Repo report completed',
            context: SendRepoReportUseCase.name,
            metadata: {
                organizationId,
                organization: organization.name,
                startDate,
                endDate,
                adminsTotal: admins.length,
                digestsSent: digests.length,
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
