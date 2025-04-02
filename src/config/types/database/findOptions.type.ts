export type FindOptions = {
    orderBy?: { [key: string]: 'ASC' | 'DESC' };
    limit?: number;
    offset?: number;
    relations?: string[];
};
