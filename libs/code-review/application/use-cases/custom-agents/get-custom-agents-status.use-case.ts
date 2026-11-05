import { Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';

import {
    CUSTOM_AGENT_RUN_LOG_TOKEN,
    type CustomAgentRunRecord,
    type ICustomAgentRunLog,
} from '@libs/code-review/domain/custom-agents/contracts';
import {
    IPullRequestsRepository,
    PULL_REQUESTS_REPOSITORY_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.repository';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';

export const CUSTOM_AGENT_STATUS_WINDOW_DAYS = 30;

/**
 * Stored findings of a custom agent sharing a pull request and statuses, as
 * the status reads them. `count` defaults to one finding.
 */
export type CustomAgentSuggestionRow = {
    agentId: string;
    prNumber: number;
    deliveryStatus?: string;
    priorityStatus?: string;
    count?: number;
};

/** How an agent's recent runs ended, newest first. */
export type CustomAgentRunHealth = {
    /** Runs recorded in the window. */
    runs: number;
    /** Pull requests where a run failed or stopped short. */
    failedPullRequests: number;
    /** The newest run. */
    last: {
        status: CustomAgentRunRecord['status'];
        reason?: string;
        at: string;
        prNumber: number;
    };
    /** Runs in a row, from the newest, that failed or stopped short. */
    streak: number;
};

/** A file findings cited as their rule while the agent does not follow it,
 *  so the check dropped them. */
export type CustomAgentUnfollowedCitation = {
    /** As the findings cited it (`repo/path`, `owner/repo:path` or a path). */
    file: string;
    findings: number;
    pullRequests: number;
};

export type CustomAgentStatus = {
    agentId: string;
    /** Pull requests where the agent left at least one finding. */
    pullRequests: number;
    posted: number;
    /** Dropped by the check, severity, limits or dedup. */
    dropped: number;
    /** Set when its runs were recorded in the window. */
    health?: CustomAgentRunHealth;
    /** Most cited first; only files that read like a guide. */
    unfollowedCitations?: CustomAgentUnfollowedCitation[];
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
        const count = row.count ?? 1;
        if (row.deliveryStatus === DeliveryStatus.SENT) {
            status.posted += count;
        } else if (isDropped(row)) {
            status.dropped += count;
        }
        byAgent.set(row.agentId, status);
    }
    return [...byAgent.values()].map(({ prs, ...status }) => ({
        ...status,
        pullRequests: prs.size,
    }));
}

/**
 * How each agent's runs ended, from the run records (newest first or not).
 * The streak counts runs in a row, from the newest, that did not finish.
 */
export function summarizeCustomAgentRuns(
    records: CustomAgentRunRecord[],
): Map<string, CustomAgentRunHealth> {
    const byAgent = new Map<string, CustomAgentRunRecord[]>();
    for (const record of records) {
        if (!record?.agentId) continue;
        byAgent.set(record.agentId, [
            ...(byAgent.get(record.agentId) ?? []),
            record,
        ]);
    }
    const health = new Map<string, CustomAgentRunHealth>();
    for (const [agentId, runs] of byAgent) {
        const newestFirst = [...runs].sort(
            (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
        );
        const unfinished = (run: CustomAgentRunRecord) => run.status !== 'ran';
        const streakEnd = newestFirst.findIndex((run) => !unfinished(run));
        const last = newestFirst[0];
        health.set(agentId, {
            runs: runs.length,
            failedPullRequests: new Set(
                runs.filter(unfinished).map((run) => run.prNumber),
            ).size,
            last: {
                status: last.status,
                ...(last.reason && { reason: last.reason }),
                at: new Date(last.at).toISOString(),
                prNumber: last.prNumber,
            },
            streak: streakEnd === -1 ? newestFirst.length : streakEnd,
        });
    }
    return health;
}

/** The quote check's reason for a finding citing a file the agent does not
 *  follow (`convention-check.ts`). */
const UNFOLLOWED_GUIDE = /^`?(.+?)`? is not a guide linked to this review$/;

/** A cited file worth offering: a guide's extension or a skill, one path. */
const READS_LIKE_GUIDE =
    /^[^\s]+\.(md|mdc|mdx|markdown|txt|rst|adoc)$|(^|\/)SKILL\.md$/i;

/** How many cited files are offered per agent. */
const MAX_UNFOLLOWED_CITATIONS = 5;

export type UnfollowedCitationRow = {
    agentId: string;
    reason: string;
    findings: number;
    prNumbers: number[];
};

/** Files each agent's dropped findings cited without following them. */
export function summarizeUnfollowedCitations(
    rows: UnfollowedCitationRow[],
): Map<string, CustomAgentUnfollowedCitation[]> {
    const byAgent = new Map<
        string,
        Map<string, { findings: number; prs: Set<number> }>
    >();
    for (const row of rows) {
        const file = UNFOLLOWED_GUIDE.exec(row?.reason ?? '')?.[1]?.trim();
        if (!row?.agentId || !file || !READS_LIKE_GUIDE.test(file)) continue;
        const files = byAgent.get(row.agentId) ?? new Map();
        const entry = files.get(file) ?? { findings: 0, prs: new Set() };
        entry.findings += row.findings;
        row.prNumbers.forEach((pr) => entry.prs.add(pr));
        files.set(file, entry);
        byAgent.set(row.agentId, files);
    }
    return new Map(
        [...byAgent].map(([agentId, files]) => [
            agentId,
            [...files]
                .map(([file, { findings, prs }]) => ({
                    file,
                    findings,
                    pullRequests: prs.size,
                }))
                .sort((a, b) => b.findings - a.findings)
                .slice(0, MAX_UNFOLLOWED_CITATIONS),
        ]),
    );
}

const unfollowedCitationsPipeline = (match: Record<string, unknown>) => [
    {
        $match: {
            ...match,
            'files.suggestions.customAgent.id': { $exists: true },
        },
    },
    { $unwind: '$files' },
    { $unwind: '$files.suggestions' },
    {
        $match: {
            'files.suggestions.customAgent.id': { $exists: true },
            'files.suggestions.discardReason': {
                $regex: 'is not a guide linked to this review$',
            },
        },
    },
    {
        $group: {
            _id: {
                agentId: '$files.suggestions.customAgent.id',
                reason: '$files.suggestions.discardReason',
            },
            findings: { $sum: 1 },
            prNumbers: { $addToSet: '$number' },
        },
    },
    {
        $project: {
            _id: 0,
            agentId: '$_id.agentId',
            reason: '$_id.reason',
            findings: 1,
            prNumbers: 1,
        },
    },
];

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
    // One row per agent, PR and status pair instead of one per finding.
    {
        $group: {
            _id: {
                agentId: '$agentId',
                prNumber: '$prNumber',
                deliveryStatus: '$deliveryStatus',
                priorityStatus: '$priorityStatus',
            },
            count: { $sum: 1 },
        },
    },
    {
        $project: {
            _id: 0,
            agentId: '$_id.agentId',
            prNumber: '$_id.prNumber',
            deliveryStatus: '$_id.deliveryStatus',
            priorityStatus: '$_id.priorityStatus',
            count: 1,
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
    private readonly logger = createLogger(GetCustomAgentsStatusUseCase.name);

    constructor(
        @Inject(PULL_REQUESTS_REPOSITORY_TOKEN)
        private readonly pullRequestsRepository: IPullRequestsRepository,
        // Optional so specs that construct the use case still compile;
        // without it the page shows findings only.
        @Optional()
        @Inject(CUSTOM_AGENT_RUN_LOG_TOKEN)
        private readonly runLog?: ICustomAgentRunLog,
    ) {}

    async execute(params: {
        organizationId: string;
        repositoryId: string;
        now?: Date;
    }): Promise<{
        windowDays: number;
        agents: CustomAgentStatus[];
        /** The runs could not be read: failures do not show, and an agent
         *  with no findings is not known to be healthy. */
        runsUnavailable?: true;
    }> {
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
        let runsUnavailable = false;
        const [fileRows, prLevelRows, citationRows, runRecords] =
            await Promise.all([
                collection
                    .aggregate(
                        suggestionRowsPipeline(match, 'files.suggestions'),
                        {
                            allowDiskUse: true,
                        },
                    )
                    .toArray(),
                collection
                    .aggregate(
                        suggestionRowsPipeline(match, 'prLevelSuggestions'),
                        {
                            allowDiskUse: true,
                        },
                    )
                    .toArray(),
                collection
                    .aggregate(unfollowedCitationsPipeline(match), {
                        allowDiskUse: true,
                    })
                    .toArray(),
                // A page that cannot read the runs still shows the findings.
                this.runLog
                    ? this.runLog
                          .listSince({
                              organizationId: params.organizationId,
                              repositoryId: params.repositoryId,
                              since,
                          })
                          .catch((error) => {
                              this.logger.warn({
                                  message:
                                      'Could not read custom agent runs; showing findings only',
                                  context: GetCustomAgentsStatusUseCase.name,
                                  error,
                                  metadata: {
                                      organizationId: params.organizationId,
                                      repositoryId: params.repositoryId,
                                      since,
                                  },
                              });
                              runsUnavailable = true;
                              return [] as CustomAgentRunRecord[];
                          })
                    : Promise.resolve([] as CustomAgentRunRecord[]),
            ]);

        const findings = summarizeCustomAgentSuggestions([
            ...fileRows,
            ...prLevelRows,
        ] as CustomAgentSuggestionRow[]);
        const health = summarizeCustomAgentRuns(runRecords);
        const citations = summarizeUnfollowedCitations(
            citationRows as UnfollowedCitationRow[],
        );
        const findingsByAgent = new Map(findings.map((s) => [s.agentId, s]));
        // An agent whose runs all failed left no finding: list it anyway.
        const agentIds = new Set([
            ...findings.map((s) => s.agentId),
            ...health.keys(),
        ]);
        return {
            windowDays: CUSTOM_AGENT_STATUS_WINDOW_DAYS,
            ...(runsUnavailable ? { runsUnavailable: true as const } : {}),
            agents: [...agentIds].map((agentId) => {
                const status = findingsByAgent.get(agentId) ?? {
                    agentId,
                    pullRequests: 0,
                    posted: 0,
                    dropped: 0,
                };
                const runHealth = health.get(agentId);
                const cited = citations.get(agentId);
                return {
                    ...status,
                    ...(runHealth && { health: runHealth }),
                    ...(cited?.length && { unfollowedCitations: cited }),
                };
            }),
        };
    }
}
