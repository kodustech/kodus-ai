"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Calendar } from "@components/ui/calendar";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { Separator } from "@components/ui/separator";
import { formatDate, isEqual, parseISO, subMonths, subWeeks } from "date-fns";
import { enUS, ptBR } from "date-fns/locale";
import { CalendarIcon } from "lucide-react";
import { type PropsRange } from "react-day-picker";

type Props = Omit<PropsRange, "mode"> & {
    onDateRangeChange: (range: { from: string; to: string }) => void;
    initialRange?: { from: string; to: string };
};

type DateRangeString = { from: string; to: string };

const dateToString = (date: Date) => formatDate(date, "yyyy-MM-dd");
const stringToDate = (date: string) => new Date(parseISO(date));

const today = new Date();

const ranges = [
    {
        label: "Today",
        range: {
            from: dateToString(today),
            to: dateToString(today),
        },
    },
    {
        label: "Last week",
        range: {
            from: dateToString(subWeeks(today, 1)),
            to: dateToString(today),
        },
    },
    {
        label: "Last 2 weeks",
        range: {
            from: dateToString(subWeeks(today, 2)),
            to: dateToString(today),
        },
    },
    {
        label: "Last month",
        range: {
            from: dateToString(subMonths(today, 1)),
            to: dateToString(today),
        },
    },
    {
        label: "Last 3 months",
        range: {
            from: dateToString(subMonths(today, 3)),
            to: dateToString(today),
        },
    },
] satisfies Array<{
    label: string;
    range: {
        from: string | undefined;
        to: string | undefined;
    };
}>;

const defaultItem = ranges[0];

export const DateRangeFilter = ({
    onDateRangeChange,
    initialRange,
    ...props
}: Props) => {
    const [selectedRange, setSelectedRange] = useState<DateRangeString | null>(
        () => {
            if (initialRange) {
                return initialRange;
            }
            return null;
        },
    );

    const label = selectedRange
        ? ranges.find(
              (r) =>
                  isEqual(selectedRange.from!, r.range.from) &&
                  isEqual(selectedRange.to!, r.range.to),
          )?.label
        : undefined;

    const from = selectedRange
        ? formatDate(parseISO(selectedRange.from), "dd/LLL/y", {
              locale: enUS,
          })
        : "";
    const to = selectedRange
        ? formatDate(parseISO(selectedRange.to), "dd/LLL/y", {
              locale: enUS,
          })
        : "";

    const handleRangeChange = (range: DateRangeString) => {
        setSelectedRange(range);
        onDateRangeChange(range);
    };

    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button
                    size="md"
                    variant="helper"
                    leftIcon={<CalendarIcon />}
                    className="w-68 justify-start">
                    {label ? (
                        label
                    ) : (
                        <span className="flex items-center gap-1 font-semibold">
                            {selectedRange?.from ? (
                                selectedRange.to ? (
                                    <>
                                        {from}
                                        <span className="text-text-secondary">
                                            -
                                        </span>
                                        {to}
                                    </>
                                ) : (
                                    from
                                )
                            ) : (
                                <span className="text-text-secondary">
                                    Select date range
                                </span>
                            )}
                        </span>
                    )}
                </Button>
            </PopoverTrigger>

            <PopoverContent
                align="end"
                className="flex w-68 flex-col items-center px-0 py-0">
                <Calendar
                    {...props}
                    mode="range"
                    locale={ptBR}
                    disabled={{ after: today }}
                    selected={{
                        from: selectedRange?.from
                            ? stringToDate(selectedRange.from)
                            : undefined,
                        to: selectedRange?.to
                            ? stringToDate(selectedRange.to)
                            : undefined,
                    }}
                    max={31 * 3} // 3 months max range (considering 31 days per month)
                    onSelect={(d) => {
                        const range = {
                            from: d?.from
                                ? dateToString(d?.from)
                                : defaultItem.range.from,
                            to: d?.to
                                ? dateToString(d?.to)
                                : d?.from
                                  ? dateToString(d.from)
                                  : defaultItem.range.to,
                        };

                        handleRangeChange(range);
                    }}
                />

                <Separator className="mb-3" />

                <div className="grid grid-cols-2 gap-1 px-3 pb-4">
                    {ranges.map((r) => (
                        <Button
                            key={r.label}
                            size="xs"
                            className="w-full"
                            variant={
                                selectedRange &&
                                isEqual(selectedRange.from!, r.range.from) &&
                                isEqual(selectedRange.to!, r.range.to)
                                    ? "primary-dark"
                                    : "helper"
                            }
                            onClick={() => {
                                handleRangeChange({
                                    from: r.range.from,
                                    to: r.range.to,
                                });
                            }}>
                            {r.label}
                        </Button>
                    ))}
                </div>
            </PopoverContent>
        </Popover>
    );
};
