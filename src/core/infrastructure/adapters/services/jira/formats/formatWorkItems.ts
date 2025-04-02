import { Item } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { BoardPriorityType } from '@/shared/domain/enums/board-priority-type.enum';
import { sanitizeString } from '@/shared/utils/helpers';
import { convertToMarkdown } from '@/shared/utils/transforms/jira';
import * as moment from 'moment';

export function formatWorkItems(
    issues,
    wipColumns,
    boardPriorityType?,
    movementFilter?,
    expandChangelog?,
    showDescription?,
): Item[] {
    let _movementFilter;

    if (movementFilter) {
        _movementFilter = movementFilter;
    } else {
        _movementFilter = (field) => field.field === 'status';
    }

    const formattedIssues = issues.map((issue) => {
        const changelog = issue.changelog?.histories
            .map((history) => ({
                id: history.id,
                createdAt: moment(history.created).format('YYYY-MM-DD HH:mm'),
                movements: history.items
                    .filter(_movementFilter)
                    .map((item) => ({
                        field: item.field,
                        fromColumnId: item.from,
                        fromColumnName: item.fromString,
                        toColumnId: item.to,
                        toColumnName: item.toString,
                    })),
            }))
            .filter(
                (changelog) =>
                    changelog.movements.length > 0 &&
                    changelog.field !== 'description',
            );

        return {
            id: issue.id,
            key: issue.key,
            name: sanitizeString(issue?.fields?.summary),
            created: issue?.fields?.created,
            updated: issue?.fields?.updated,
            description: showDescription
                ? typeof issue?.fields?.description === 'string'
                    ? issue?.fields?.description
                    : issue?.fields?.description?.content
                          ?.map((item) => convertToMarkdown(item.content))
                          ?.join()
                : null,
            changelog: expandChangelog ? changelog : null,
            workItemCreatedAt: issue?.fields?.created,
            workItemDeliveredAt: issue?.fields?.resolutiondate,
            columnId: issue?.fields?.status?.id,
            columnName: issue?.fields?.status?.name,
            priority: issue?.fields?.priority?.name,
            priorityId: issue?.fields?.priority?.id,
            lexoRank: issue?.fields?.customfield_10019,
            flagged: !!issue?.fields?.customfield_10021?.find(
                (c: { value: string }) => c?.value?.includes('Impediment'),
            ),
            assignee: issue.fields.assignee
                ? {
                      accountId: issue.fields?.assignee?.accountId,
                      userEmail: issue.fields?.assignee?.emailAddress,
                      userName: issue.fields?.assignee?.displayName,
                  }
                : null,
            workItemType: {
                name: issue?.fields?.issuetype?.name,
                id: issue?.fields?.issuetype?.id,
                description: issue?.fields?.issuetype?.description,
                subtask: issue?.fields?.issuetype?.subtask,
            },
            status: {
                name: issue?.fields?.status?.name,
                id: issue?.fields?.status?.id,
                statusCategory: {
                    name: issue?.fields?.status?.statusCategory?.name,
                    id: issue?.fields?.status?.statusCategory?.id,
                },
            },
        };
    });

    return organizeAndRankIssues(
        formattedIssues,
        wipColumns,
        boardPriorityType,
    );
}

function organizeAndRankIssues(
    formattedWorkItems,
    wipColumns,
    boardPriorityType,
) {
    const rankedIssues = [];

    switch (boardPriorityType?.configValue[0].priorityType) {
        case BoardPriorityType.LEXORANK_PRIORITY:
            rankedIssues.push(
                ...sortByLexoRank(formattedWorkItems, wipColumns),
            );
            break;
        case BoardPriorityType.PRIORITY_FIELD:
            rankedIssues.push(
                ...sortByPriorityField(
                    formattedWorkItems,
                    wipColumns,
                    boardPriorityType.configValue[1].priorityLevels,
                ),
            );
            break;
        case BoardPriorityType.KANBAN_PRIORITY:
            rankedIssues.push(
                ...sortByLexoRank(formattedWorkItems, wipColumns),
            );
            break;
        default:
            rankedIssues.push(...formattedWorkItems);
            break;
    }

    return formattedWorkItems.map((issue) => {
        const rankedIssue = rankedIssues.find((ri) => ri.id === issue.id);
        return rankedIssue ? { ...issue, rank: rankedIssue.rank } : issue;
    });
}

function sortByLexoRank(formattedWorkItems, wipColumns) {
    let rank = 1;
    const sortedWorkItems = [];

    for (const column of wipColumns) {
        const issuesInColumn = formattedWorkItems
            .filter((issue) => issue.columnId === column.id)
            .sort((a, b) => {
                if (a.lexoRank < b.lexoRank) return -1;
                if (a.lexoRank > b.lexoRank) return 1;
                return 0;
            });

        for (const issue of issuesInColumn) {
            issue.rank = rank++;
            sortedWorkItems.push(issue);
        }
    }

    return sortedWorkItems;
}

function sortByPriorityField(formattedWorkItems, wipColumns, priorityLevels) {
    const wipColumnOrderMap = wipColumns.reduce((map, column) => {
        map[column.id] = column.order;
        return map;
    }, {});

    const priorityOrderMap = priorityLevels.reduce((map, level) => {
        map[level.id] = level.order;
        return map;
    }, {});

    const sortedItems = formattedWorkItems.sort((a, b) => {
        const aColumnOrder = wipColumnOrderMap[a.status.id] || 0;
        const bColumnOrder = wipColumnOrderMap[b.status.id] || 0;

        if (aColumnOrder !== bColumnOrder) {
            return bColumnOrder - aColumnOrder;
        } else {
            const aPriorityOrder = priorityOrderMap[a.priorityId] || 0;
            const bPriorityOrder = priorityOrderMap[b.priorityId] || 0;
            return aPriorityOrder - bPriorityOrder;
        }
    });

    sortedItems.forEach((item, index) => {
        item.rank = index + 1;
    });

    return sortedItems;
}
