import type { FilterValueGroup } from "src/core/utils/filtering";

import { columns } from "./columns";

export const DEFAULT_FILTERS: FilterValueGroup = {
    condition: "and",
    items: [{ field: "status", operator: "is", value: "open" }],
};

export const COLUMNS_WITHOUT_SELECT = columns.filter((c) => c.meta?.name);

export const COLUMNS_META_OBJECT = COLUMNS_WITHOUT_SELECT.reduce(
    (acc, current) => {
        acc[current.id!] = { meta: current.meta };
        return acc;
    },
    {} as Record<string, Pick<(typeof columns)[number], "meta">>,
);

const ADDITIONAL_FILTER_FIELDS: Record<
    string,
    Pick<(typeof columns)[number], "meta">
> = {
    "kodyRule.number": {
        meta: {
            name: "Kody Rule ID",
            filters: {
                "is": true,
                "is-not": true,
            },
            filtersValueInputType: "text",
        },
    },
};

Object.assign(COLUMNS_META_OBJECT, ADDITIONAL_FILTER_FIELDS);

const LOCAL_STORAGE_FILTERS_KEY = "issues/filters";

export const deleteFiltersInLocalStorage = () =>
    globalThis.localStorage.removeItem(LOCAL_STORAGE_FILTERS_KEY);

export const saveFiltersToLocalStorage = (filter: FilterValueGroup) => {
    globalThis.localStorage.setItem(
        LOCAL_STORAGE_FILTERS_KEY,
        JSON.stringify(filter),
    );
};

export const getFiltersInLocalStorage = (): FilterValueGroup | undefined => {
    const localFilterAsString = globalThis.localStorage?.getItem(
        LOCAL_STORAGE_FILTERS_KEY,
    );
    if (!localFilterAsString) return undefined;

    try {
        return JSON.parse(localFilterAsString);
    } catch (error) {
        return undefined;
    }
};
