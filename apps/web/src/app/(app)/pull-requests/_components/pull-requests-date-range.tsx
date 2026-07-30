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
import { cn } from "src/core/utils/components";
import {
    formatDate,
    parseISO,
    subDays,
    subMonths,
    subWeeks,
} from "date-fns";
import { enUS } from "date-fns/locale";
import { CalendarIcon, XIcon } from "lucide-react";
import { type DateRange } from "react-day-picker";

// Decoupled sibling of the cockpit DateRangePicker: same Calendar + presets,
// but instead of the cockpit cookie/URL param + full-page reload it just reports
// the picked range through `onChange`, so the Pull Requests screen can drive its
// nuqs `createdAtFrom/To` filters. Unlike the cockpit one the range is optional
// (empty = no date filter).
type Props = {
    from?: string | null;
    to?: string | null;
    onChange: (from: string | null, to: string | null) => void;
};

const dateToString = (date: Date) => formatDate(date, "yyyy-MM-dd");
const stringToDate = (date: string) => new Date(parseISO(date));

const today = new Date();
const presets = [
    {
        label: "Last week",
        from: dateToString(subWeeks(today, 1)),
        to: dateToString(today),
    },
    {
        label: "Last 15 days",
        from: dateToString(subDays(today, 15)),
        to: dateToString(today),
    },
    {
        label: "Last month",
        from: dateToString(subMonths(today, 1)),
        to: dateToString(today),
    },
    {
        label: "Last 3 months",
        from: dateToString(subMonths(today, 3)),
        to: dateToString(today),
    },
];

export const PullRequestsDateRange = ({ from, to, onChange }: Props) => {
    const [open, setOpen] = useState(false);
    // The range being picked while the popover is open; committed on close so a
    // start→end pick costs a single filter update.
    const [pending, setPending] = useState<DateRange | undefined>();
    const hasRange = Boolean(from && to);

    const commit = (d: DateRange | undefined) => {
        if (!d?.from) return;
        onChange(dateToString(d.from), dateToString(d.to ?? d.from));
    };

    const presetLabel = presets.find(
        (p) => p.from === from && p.to === to,
    )?.label;

    const triggerLabel = !hasRange
        ? "Any date"
        : (presetLabel ??
          `${formatDate(parseISO(from!), "dd/LLL", { locale: enUS })} – ${formatDate(
              parseISO(to!),
              "dd/LLL",
              { locale: enUS },
          )}`);

    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (!next && pending?.from) {
                    commit(pending);
                    setPending(undefined);
                }
            }}>
            <PopoverTrigger asChild>
                <Button
                    size="sm"
                    variant="helper"
                    leftIcon={<CalendarIcon />}
                    className={cn(
                        "h-9 justify-start gap-1.5 rounded-lg",
                        hasRange && "border-primary-light/50",
                    )}>
                    {triggerLabel}
                    {hasRange && (
                        <XIcon
                            className="text-text-tertiary hover:text-text-primary ml-0.5 size-3.5"
                            onClick={(e) => {
                                e.stopPropagation();
                                setPending(undefined);
                                onChange(null, null);
                            }}
                        />
                    )}
                </Button>
            </PopoverTrigger>

            <PopoverContent
                align="start"
                className="flex w-68 flex-col items-center px-0 py-0">
                <Calendar
                    mode="range"
                    locale={enUS}
                    disabled={{ after: today }}
                    resetOnSelect
                    max={31 * 3}
                    selected={
                        pending ?? {
                            from: from ? stringToDate(from) : undefined,
                            to: to ? stringToDate(to) : undefined,
                        }
                    }
                    onSelect={(d) => {
                        setPending(d);
                        if (d?.from && d?.to) {
                            setOpen(false);
                            commit(d);
                            setPending(undefined);
                        }
                    }}
                />

                <Separator className="mb-3" />

                <div className="grid w-full grid-cols-2 gap-1 px-3 pb-4">
                    {presets.map((p) => (
                        <Button
                            key={p.label}
                            size="xs"
                            className="w-full"
                            variant={
                                p.from === from && p.to === to
                                    ? "primary-dark"
                                    : "helper"
                            }
                            onClick={() => {
                                setOpen(false);
                                setPending(undefined);
                                onChange(p.from, p.to);
                            }}>
                            {p.label}
                        </Button>
                    ))}
                    <Button
                        size="xs"
                        variant="cancel"
                        className="col-span-2 w-full"
                        disabled={!hasRange}
                        onClick={() => {
                            setOpen(false);
                            setPending(undefined);
                            onChange(null, null);
                        }}>
                        Clear date
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
};
