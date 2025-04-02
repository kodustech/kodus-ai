import { Item } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { convertToMarkdown } from '@/shared/utils/transforms/jira';
import { formatAndFilterChangelog } from './formatChangelog';

export function formatWorkItem(issue, movementFilter?): Item {
    let _movementFilter;

    if (movementFilter) {
        _movementFilter = movementFilter;
    } else {
        _movementFilter = (field) => field.field === 'status';
    }

    const changelog = formatAndFilterChangelog(
        issue.changelog.histories,
        _movementFilter,
    );

    return {
        id: issue.id,
        key: issue.key,
        name: issue?.fields?.summary,
        description:
            typeof issue?.fields?.description === 'string'
                ? issue?.fields?.description
                : issue?.fields?.description?.content
                      ?.map((item) => convertToMarkdown(item.content))
                      ?.join(),
        changelog: changelog,
        workItemCreatedAt: issue?.fields?.created,
        workItemDeliveredAt: issue?.fields?.resolutiondate,
        columnName: issue?.fields?.status?.name,
        priority: issue?.fields?.priority?.name,
        flagged: !!issue?.fields?.customfield_10021?.find(
            (c: { value: string }) => c?.value?.includes('Impediment'),
        ),
        assignee: issue.fields?.assignee
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
            lastChangedDate: issue?.fields?.statuscategorychangedate,
        },
    };
}
