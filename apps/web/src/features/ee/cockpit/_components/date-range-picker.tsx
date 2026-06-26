"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@components/ui/button";
import { Calendar } from "@components/ui/calendar";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { Separator } from "@components/ui/separator";
import { Spinner } from "@components/ui/spinner";
import { formatDate, isEqual, parseISO, subMonths, subWeeks } from "date-fns";
import { enUS } from "date-fns/locale";
import { CalendarIcon } from "lucide-react";
import { type PropsRange } from "react-day-picker";

import { setCockpitDateRangeCookie } from "../_actions/set-cockpit-date-range";
import { COCKPIT_PARAM } from "../_constants";

type Props = Omit<PropsRange, "mode"> & {
    cookieValue: string | undefined;
};

type DateRangeString = { from: string; to: string };

const dateToString = (date: Date) => formatDate(date, "yyyy-MM-dd");
const stringToDate = (date: string) => new Date(parseISO(date));

const today = new Date();
const ranges = [
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

export const DateRangePicker = ({ cookieValue, ...props }: Props) => {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [loading, startTransition] = useTransition();
    const [open, setOpen] = useState(false);

    const [selectedRange, setSelectedRange] = useState<DateRangeString>(() => {
        // URL wins: keep the trigger label in sync with a shared link.
        const urlFrom = searchParams.get(COCKPIT_PARAM.start);
        const urlTo = searchParams.get(COCKPIT_PARAM.end);
        if (urlFrom && urlTo) return { from: urlFrom, to: urlTo };

        const cookie = cookieValue;

        if (!cookie) return defaultItem.range;

        let cookieDateRange: DateRangeString;
        try {
            cookieDateRange = JSON.parse(cookie) as DateRangeString;
        } catch (e) {
            return defaultItem.range;
        }

        if (!cookieDateRange.from || !cookieDateRange.to)
            return defaultItem.range;

        return {
            from: cookieDateRange.from,
            to: cookieDateRange.to,
        };
    });

    // Persist to cookie (cross-session default) and push the range onto
    // the URL (source of truth) so the view is shareable. The navigation
    // re-runs the server slots, which now read the range from the URL.
    const commitRange = (range: DateRangeString) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set(COCKPIT_PARAM.start, range.from);
        params.set(COCKPIT_PARAM.end, range.to);

        startTransition(async () => {
            await setCockpitDateRangeCookie(range);
            router.push(`${pathname}?${params.toString()}`);
        });
    };

    const label = ranges.find(
        (r) =>
            isEqual(selectedRange?.from!, r.range.from) &&
            isEqual(selectedRange?.to!, r.range.to),
    )?.label;

    const from = formatDate(parseISO(selectedRange.from), "dd/LLL/y", {
        locale: enUS,
    });
    const to = formatDate(parseISO(selectedRange.to), "dd/LLL/y", {
        locale: enUS,
    });

    return (
        <>
            {loading && (
                <div className="fixed inset-0 z-5 flex flex-col items-center justify-center gap-4 bg-black/70 backdrop-blur-sm">
                    <Spinner className="size-16" />

                    <span className="text-sm font-semibold">
                        Changing date range from
                        <span className="text-primary-light mx-1 font-semibold">
                            {from}
                        </span>
                        to
                        <span className="text-primary-light ml-1 font-semibold">
                            {to}
                        </span>
                    </span>
                </div>
            )}

            <Popover open={open} onOpenChange={setOpen}>
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
                                        Select a range
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
                        locale={enUS}
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

                            setOpen(false);
                            setSelectedRange(range);
                            commitRange(range);
                        }}
                    />

                    <Separator className="mb-3" />

                    <div className="grid grid-cols-2 gap-1 px-0 pb-4">
                        {ranges.map((r) => (
                            <Button
                                key={r.label}
                                size="xs"
                                className="w-full"
                                variant={
                                    isEqual(
                                        selectedRange?.from!,
                                        r.range.from,
                                    ) && isEqual(selectedRange?.to!, r.range.to)
                                        ? "primary-dark"
                                        : "helper"
                                }
                                onClick={() => {
                                    setOpen(false);
                                    setSelectedRange({
                                        from: r.range.from,
                                        to: r.range.to,
                                    });
                                    commitRange({
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
        </>
    );
};
