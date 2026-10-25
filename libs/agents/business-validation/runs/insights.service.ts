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
        const since = new Date(Date.now() - 30 * DAY_MS);
        const scope = {
            teamId: filter.teamId,
            repositoryIds: filter.repositoryId
                ? [filter.repositoryId]
                : undefined,
        };
        const [latest, signals] = await Promise.all([
            this.runs.latestPerPullRequest(
                organizationId,
                { from: since },
                scope,
            ),
            this.runs.statusSignals(organizationId, since, scope),
        ]);
        return summarizeStatus(newestFirst([...latest, ...signals]));
    }

    async intent(
        organizationId: string,
        range: {
            startDate: Date;
            endDate: Date;
            teamId?: string;
            /** Only these repositories; all the caller can read when absent. */
            repositoryIds?: string[];
            /** The repository the Cockpit's picker chose. */
            repositoryName?: string;
        },
    ): Promise<IntentCockpit & { previousMetRate?: number }> {
        const span = range.endDate.getTime() - range.startDate.getTime();
        const scope = {
            teamId: range.teamId,
            repositoryIds: range.repositoryIds,
            repositoryName: range.repositoryName,
        };
        const [current, previous] = await Promise.all([
            this.runs.latestPerPullRequest(
                organizationId,
                { from: range.startDate, to: range.endDate },
                scope,
            ),
            this.runs.latestPerPullRequest(
                organizationId,
                {
                    from: new Date(range.startDate.getTime() - span),
                    to: new Date(range.startDate.getTime() - 1),
                },
                scope,
            ),
        ]);
        const summary = summarizeIntent(current);
        const before = summarizeIntent(previous);
        return {
            ...summary,
            ...(before.metRate !== undefined
                ? { previousMetRate: before.metRate }
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

/** Runs once each, newest first, as the summaries read them. */
function newestFirst(runs: ValidationRunRecord[]): ValidationRunRecord[] {
    const byId = new Map(runs.map((run) => [run.id, run]));
    return [...byId.values()].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
}
