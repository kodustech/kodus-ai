export enum StatusCategoryJira {
    NEW = 'new',
    INDETERMINATE = 'indeterminate',
    DONE = 'done',
}

export const StatusCategoryToColumn = {
    // [StatusCategoryJira.NEW]: 'todo', // not used for now
    [StatusCategoryJira.INDETERMINATE]: 'wip',
    [StatusCategoryJira.DONE]: 'done',
};
