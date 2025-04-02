const moduleWorkItems = () => {
    return [
        {
            name: 'default',
            workItemTypes: [
                {
                    id: '10005',
                    name: 'Task',
                    subtask: false,
                    description: 'A small, distinct piece of work.',
                },
                {
                    id: '10019',
                    name: 'Sub-task',
                    subtask: true,
                    description:
                        "A small piece of work that's part of a larger task.",
                },
                {
                    id: '10004',
                    name: 'Story',
                    subtask: false,
                    description:
                        'Functionality or a feature expressed as a user goal.',
                },
                {
                    id: '10007',
                    name: 'Bug',
                    subtask: false,
                    description: 'A problem or error.',
                },
            ],
        },
        {
            name: 'automation__improve_task_description',
            workItemTypes: [
                {
                    id: '10005',
                    name: 'Task',
                    subtask: false,
                    description: 'A small, distinct piece of work.',
                },
                {
                    id: '10019',
                    name: 'Sub-task',
                    subtask: true,
                    description:
                        "A small piece of work that's part of a larger task.",
                },
                {
                    id: '10004',
                    name: 'Story',
                    subtask: false,
                    description:
                        'Functionality or a feature expressed as a user goal.',
                },
                {
                    id: '10007',
                    name: 'Bug',
                    subtask: false,
                    description: 'A problem or error.',
                },
            ],
        },
    ];
};

export { moduleWorkItems };
