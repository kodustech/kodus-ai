import { Inject, Injectable } from '@nestjs/common';

import {
    IPullRequestsRepository,
    PULL_REQUESTS_REPOSITORY_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.repository';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';

export const CUSTOM_AGENT_STATUS_WINDOW_DAYS = 30;

/** One stored finding of a custom agent, as the status reads it. */
export type CustomAgentSuggestionRow = {
    agentId: string;
    prNumber: number;
    deliveryStatus?: string;
    priorityStatus?: string;
};

export type CustomAgentStatus = {
    agentId: string;
    /** Pull requests where the agent left at least one finding. */
    pullRequests: number;
    posted: number;
    /** Dropped by the check, severity, limits or dedup. */
    dropped: number;
};

const isDropped = (row: CustomAgentSuggestionRow) =>
    typeof row.priorityStatus === 'string' &&
    row.priorityStatus.startsWith('discarded');

export function summarizeCustomAgentSuggestions(
    rows: CustomAgentSuggestionRow[],
): CustomAgentStatus[] {
    const byAgent = new Map<string, CustomAgentStatus & { prs: Set<number> }>();
    for (const row of rows) {
        if (!row?.agentId) continue;
        const status = byAgent.get(row.agentId) ?? {
            agentId: row.agentId,
            pullRequests: 0,
            posted: 0,
            dropped: 0,
            prs: new Set<number>(),
        };
        status.prs.add(row.prNumber);
        if (row.deliveryStatus === DeliveryStatus.SENT) {
            status.posted += 1;
        } else if (isDropped(row)) {
            status.dropped += 1;
        }
        byAgent.set(row.agentId, status);
    }
    return [...byAgent.values()].map(({ prs, ...status }) => ({
        ...status,
        pullRequests: prs.size,
    }));
}

const suggestionRowsPipeline = (
    match: Record<string, unknown>,
    path: 'files.suggestions' | 'prLevelSuggestions',
) => [
    { $match: { ...match, [`${path}.customAgent.id`]: { $exists: true } } },
    ...(path === 'files.suggestions'
        ? [{ $unwind: '$files' }, { $unwind: '$files.suggestions' }]
        : [{ $unwind: '$prLevelSuggestions' }]),
    { $match: { [`${path}.customAgent.id`]: { $exists: true } } },
    {
        $project: {
            _id: 0,
            agentId: `$${path}.customAgent.id`,
            prNumber: '$number',
            deliveryStatus: `$${path}.deliveryStatus`,
            priorityStatus: `$${path}.priorityStatus`,
        },
    },
];

/**
 * What each custom agent of a repository did over the last 30 days, read
 * from the findings stored with `customAgent.id`. A run that found nothing
 * leaves no finding, so it is not counted.
 */
@Injectable()
export class GetCustomAgentsStatusUseCase {
    constructor(
        @Inject(PULL_REQUESTS_REPOSITORY_TOKEN)
        private readonly pullRequestsRepository: IPullRequestsRepository,
    ) {}

    async execute(params: {
        organizationId: string;
        repositoryId: string;
        now?: Date;
    }): Promise<{ windowDays: number; agents: CustomAgentStatus[] }> {
        const since = new Date(
            (params.now ?? new Date()).getTime() -
                CUSTOM_AGENT_STATUS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
        );
        const match = {
            'organizationId': params.organizationId,
            'repository.id': params.repositoryId,
            'updatedAt': { $gte: since },
        };
        const collection = this.pullRequestsRepository.getNativeCollection();
        const [fileRows, prLevelRows] = await Promise.all([
            collection
                .aggregate(suggestionRowsPipeline(match, 'files.suggestions'))
                .toArray(),
            collection
                .aggregate(suggestionRowsPipeline(match, 'prLevelSuggestions'))
                .toArray(),
        ]);

        return {
            windowDays: CUSTOM_AGENT_STATUS_WINDOW_DAYS,
            agents: summarizeCustomAgentSuggestions([
                ...fileRows,
                ...prLevelRows,
            ] as CustomAgentSuggestionRow[]),
        };
    }
}
