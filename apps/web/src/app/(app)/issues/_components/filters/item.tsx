"use client";

import { useMemo } from "react";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { useIssues } from "@services/issues/hooks";
import { XIcon } from "lucide-react";
import { type FilterValueItem, type Operator } from "src/core/utils/filtering";

import { COLUMNS_META_OBJECT } from "../../_constants";

export const FilterItem = ({
    filter,
    setFilter,
}: {
    filter: FilterValueItem;
    setFilter: (f: FilterValueItem | undefined) => void;
}) => {
    const { data: issues } = useIssues();

    const getFieldMeta = (field: string) =>
        (COLUMNS_META_OBJECT[field]?.meta as
            | {
                  filtersValueInputType?: "text" | "options";
              }
            | undefined) ?? { filtersValueInputType: "options" };

    const currentFieldMeta = getFieldMeta(filter.field);
    const filterValueInputType =
        currentFieldMeta.filtersValueInputType ?? "options";

    const OPERATORS_OPTIONS = Object.keys(
        COLUMNS_META_OBJECT[filter.field]?.meta?.filters ?? {},
    ) as Operator[];

    const values = useMemo(
        () => [
            ...new Set(
                issues.map((i) => {
                    const splittedByDots = filter.field.split(".");

                    if (splittedByDots.length === 1)
                        return i[filter.field as keyof typeof i];

                    return splittedByDots.reduce<any>(
                        (acc, current) => acc?.[current],
                        i,
                    );
                }),
            ),
        ],
        [issues, filter],
    );

    return (
        <div className="flex items-center gap-2">
            <Select
                value={filter.field}
                onValueChange={(v) => {
                    let operator = filter.operator;
                    let value = filter.value;

                    const OPERATORS_OPTIONS = Object.keys(
                        COLUMNS_META_OBJECT[v]?.meta?.filters ?? {},
                    ) as Operator[];

                    if (!OPERATORS_OPTIONS.includes(filter.operator)) {
                        operator = OPERATORS_OPTIONS[0];
                    }

                    const nextFieldMeta = getFieldMeta(v);
                    const nextFieldInputType =
                        nextFieldMeta.filtersValueInputType ?? "options";

                    const values = [
                        ...new Set(
                            issues.map((i) => {
                                const splittedByDots = v.split(".");

                                if (splittedByDots.length === 1)
                                    return i[v as keyof typeof i];

                                return splittedByDots.reduce<any>(
                                    (acc, current) => acc?.[current],
                                    i,
                                );
                            }),
                        ),
                    ];

                    if (operator === "is" || operator === "is-not") {
                        value = nextFieldInputType === "text" ? "" : values[0];
                    } else if (
                        operator === "contains" ||
                        operator === "does-not-contain"
                    ) {
                        value = operator === filter.operator ? value : "";
                    }

                    setFilter({ ...filter, operator, value, field: v });
                }}>
                <SelectTrigger size="xs" className="w-fit capitalize">
                    <SelectValue placeholder="Field" />
                </SelectTrigger>

                <SelectContent className="min-w-36">
                    {Object.entries(COLUMNS_META_OBJECT)
                        .filter(([, { meta }]) => meta?.filters)
                        .map(([s, { meta }]) => (
                            <SelectItem
                                key={s}
                                value={s}
                                className="min-h-auto gap-1.5 px-3 py-1.5 pr-4 text-xs capitalize [--icon-size:calc(var(--spacing)*4)]">
                                {meta?.name}
                            </SelectItem>
                        ))}
                </SelectContent>
            </Select>

            {filter.field.length > 0 && (
                <Select
                    value={filter.operator}
                    onValueChange={(v) =>
                        setFilter({ ...filter, operator: v as Operator })
                    }>
                    <SelectTrigger size="xs" className="w-fit">
                        <SelectValue placeholder="Operator" />
                    </SelectTrigger>

                    <SelectContent className="min-w-36">
                        {OPERATORS_OPTIONS.map((o) => (
                            <SelectItem
                                key={o}
                                value={o}
                                className="min-h-auto gap-1.5 px-3 py-1.5 pr-4 text-xs [--icon-size:calc(var(--spacing)*4)]">
                                {o.replaceAll("-", " ")}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}

            {filter.field.length > 0 && (
                <>
                    {(filter.operator === "is" ||
                        filter.operator === "is-not") && (
                        <>
                            {filterValueInputType === "text" ? (
                                <Input
                                    className="h-7 w-32 flex-1 rounded-full px-3 text-xs"
                                    placeholder="Type the ID..."
                                    value={filter.value ?? ""}
                                    onChange={(ev) =>
                                        setFilter({
                                            ...filter,
                                            value: ev.target.value,
                                        })
                                    }
                                />
                            ) : (
                                <Select
                                    value={filter.value}
                                    onValueChange={(v) =>
                                        setFilter({ ...filter, value: v })
                                    }>
                                    <SelectTrigger
                                        size="xs"
                                        className="w-fit flex-1">
                                        <SelectValue placeholder="Value" />
                                    </SelectTrigger>

                                    <SelectContent className="min-w-36">
                                        {values.map((s) => (
                                            <SelectItem
                                                key={s}
                                                value={s}
                                                className="min-h-auto gap-1.5 px-3 py-1.5 pr-4 text-xs [--icon-size:calc(var(--spacing)*4)]">
                                                {s}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}
                        </>
                    )}

                    {(filter.operator === "contains" ||
                        filter.operator === "does-not-contain") && (
                        <Input
                            className="h-7 w-32 flex-1 rounded-full px-3 text-xs"
                            placeholder="Type something..."
                            value={filter.value ?? ""}
                            onChange={(ev) =>
                                setFilter({ ...filter, value: ev.target.value })
                            }
                        />
                    )}
                </>
            )}

            <Button
                size="icon-xs"
                variant="tertiary"
                className="text-tertiary-light size-4 min-h-auto [--icon-size:calc(var(--spacing)*3)]"
                onClick={() => setFilter(undefined)}>
                <XIcon />
            </Button>
        </div>
    );
};
