export type ChangelogEntry = {
    id: string;
    created: Date;
    items: Array<{
        field: string;
        fieldtype: string;
        from?: string;
        fromString?: string;
        to?: string;
        toString?: string;
    }>;
};
