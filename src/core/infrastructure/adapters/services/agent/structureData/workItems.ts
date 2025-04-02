export const WORKITEM_STRUCTURE_DATA = {
    work_item_glossary: {
        'id': 'Unique identifier for the work item',
        'key': 'Unique key associated with the work item',
        'name': 'Name or title of the work item',
        'created': 'Datetime when the work item was created',
        'updated': 'Datetime when the work item was last updated',
        'description': 'Detailed description of the work item',
        'changelog': 'Log of all changes made to the work item',
        'workItemCreatedAt':
            'Timestamp when the work item was created (duplicate with "created")',
        'workItemDeliveredAt':
            'Timestamp when the work item was delivered',
        'columnId':
            'Unique identifier for the column the work item is currently in',
        'columnName': 'Name of the column the work item is currently in',
        'priority': 'Priority level assigned to the work item',
        'priorityId': 'Unique identifier for the priority level',
        'lexoRank':
            'Ranking used for sorting work items (format: 0|i000p2:z0g000i0000000004)',
        'flagged':
            'Indicates if the work item is currently impeded (true/false)',
        'assignee':
            'Object containing details of the user assigned to the work item (includes userName, accountId, userEmail)',
        'assignee.accountId':
            'Unique identifier for the user assigned to the work item',
        'assignee.userName': 'Name of the user assigned to the work item',
        'assignee.userEmail':
            'Email address of the user assigned to the work item',
        'workItemType':
            'Object with details about the work item type (includes name, id, description, subtask)',
        'workItemType.name': 'Name of the work item type',
        'workItemType.id': 'Unique identifier for the work item type',
        'workItemType.description': 'Description of the work item type',
        'workItemType.subtask':
            'Indicates if the work item is a subtask (true/false)',
        'status':
            'Object containing details about the current status of the work item (includes id, name, statusCategory)',
        'status.name': 'Name of the current status of the work item',
        'status.id': 'Unique identifier for the current status',
        'status.statusCategory':
            'Object containing details about the status category (includes id, name)',
        'status.statusCategory.id': 'Unique identifier for the status category',
        'status.statusCategory.name': 'Name of the status category',
    },
};
