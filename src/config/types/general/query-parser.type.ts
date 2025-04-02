import { Json } from './json.type';

export type QueryParser = {
    filter: Json;
    options: QueryParserOptions;
};

export type PopulatePath = {
    path: string;
    populate: string | PopulatePath;
};

export type QueryParserOptions = {
    select?: Json;
    populate?: PopulatePath[];
    limit?: number;
    page?: number;
    sort?: Json;
    lean?: boolean;
};
