/**
 * The aggregations behind the custom agents status page, over the pull
 * requests of one repository.
 */
import type { CustomAgentFindingsScope } from '@libs/platformData/domain/pullRequests/interfaces/custom-agent-findings.interface';

export const customAgentScopeMatch = (scope: CustomAgentFindingsScope) => ({
    'organizationId': scope.organizationId,
    'repository.id': scope.repositoryId,
    'updatedAt': { $gte: scope.since },
});

export const unfollowedCitationsPipeline = (match: Record<string, unknown>) => [
    {
        $match: {
            ...match,
            'files.suggestions.customAgent.id': { $exists: true },
        },
    },
    // Only what the stages below read: each `$unwind` copies the document
    // once per element, and the whole PR (patches, every suggestion's text)
    // is most of what it weighs.
    {
        $project: {
            'number': 1,
            'files.suggestions.customAgent.id': 1,
            'files.suggestions.discardReason': 1,
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

export const suggestionRowsPipeline = (
    match: Record<string, unknown>,
    path: 'files.suggestions' | 'prLevelSuggestions',
) => [
    { $match: { ...match, [`${path}.customAgent.id`]: { $exists: true } } },
    // Only what the stages below read, before the `$unwind` copies.
    {
        $project: {
            number: 1,
            [`${path}.customAgent.id`]: 1,
            [`${path}.deliveryStatus`]: 1,
            [`${path}.priorityStatus`]: 1,
        },
    },
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
