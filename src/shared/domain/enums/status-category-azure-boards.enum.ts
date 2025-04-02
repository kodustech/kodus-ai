export enum StatusCategoryAzureBoards {
    TODO = 'incoming',
    INDETERMINATE = 'inProgress',
    DONE = 'outgoing',
}

export const StatusCategoryToColumn = {
    // [StatusCategoryAzureBoards.TODO]: 'todo', // not used for now
    [StatusCategoryAzureBoards.INDETERMINATE]: 'wip',
    [StatusCategoryAzureBoards.DONE]: 'done',
};
