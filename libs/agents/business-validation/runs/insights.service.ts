import { Injectable } from '@nestjs/common';

import {
    type BusinessLogicStatus,
    type IntentCockpit,
    summarizeIntent,
    summarizeStatus,
} from './insights';
import {
    type ValidationRunRecord,
    ValidationRunRepository,
} from './validation-run.repository';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the Business Logic card and the Cockpit read from recorded runs. */
@Injectable()
export class BusinessLogicInsightsService {
    constructor(private readonly runs: ValidationRunRepository) {}

    /** The last 30 days, for the settings card. */
    async status(
        organizationId: string,
        filter: { teamId?: string; repositoryId?: string } = {},
    ): Promise<BusinessLogicStatus> {
        const runs = await this.runs.findSince(
            organizationId,
            new Date(Date.now() - 30 * DAY_MS),
            {
                teamId: filter.teamId,
                repositoryIds: filter.repositoryId
                    ? [filter.repositoryId]
                    : undefined,
            },
        );
        return summarizeStatus(runs);
    }

    async intent(
        organizationId: string,
        range: { startDate: Date; endDate: Date; teamId?: string },
    ): Promise<IntentCockpit & { previousMetRate?: number }> {
        const span = range.endDate.getTime() - range.startDate.getTime();
        const runs = await this.runs.findSince(
            organizationId,
            new Date(range.startDate.getTime() - span),
            { teamId: range.teamId },
        );
        const inRange = (r: ValidationRunRecord) =>
            r.createdAt >= range.startDate && r.createdAt <= range.endDate;
        const before = (r: ValidationRunRecord) =>
            r.createdAt < range.startDate;
        const current = summarizeIntent(runs.filter(inRange));
        const previous = summarizeIntent(runs.filter(before));
        return {
            ...current,
            ...(previous.metRate !== undefined
                ? { previousMetRate: previous.metRate }
                : {}),
        };
    }

    /** A PR's runs, newest first: what support reads to answer "why didn't it validate?" (UC-43). */
    async pullRequestRuns(params: {
        organizationId: string;
        repositoryId: string;
        pullRequestNumber: number;
    }): Promise<ValidationRunRecord[]> {
        return this.runs.forPullRequest(params);
    }
}
