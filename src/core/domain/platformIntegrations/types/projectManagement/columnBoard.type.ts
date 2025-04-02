import { StatusCategoryJira } from '@/shared/domain/enums/status-category-jira.enum';

export type ColumnBoard = {
    id: string;
    name: string;
    untranslatedName: string;
    statusCategory:
        | StatusCategoryJira.NEW
        | StatusCategoryJira.INDETERMINATE
        | StatusCategoryJira.DONE;
};
