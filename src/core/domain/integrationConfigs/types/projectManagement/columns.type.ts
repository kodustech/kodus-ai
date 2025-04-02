export type ColumnsConfigKey = {
    name: string;
    id: string;
    column: 'todo' | 'wip' | 'done';
    order?: number;
};

export type ColumnsConfigResult = {
    allColumns: ColumnsConfigKey[];
    todoColumns: string[];
    wipColumns: string[];
    doneColumns: string[];
};
