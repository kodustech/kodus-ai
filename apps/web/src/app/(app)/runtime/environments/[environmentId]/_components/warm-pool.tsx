"use client";

import { Fragment, useId, useState } from "react";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
import { RadioGroup } from "@components/ui/radio-group";
import { toast } from "@components/ui/toaster/use-toast";
import type {
    EnvironmentPool,
    PoolPolicy,
    PoolReason,
    PoolWeekday,
} from "@services/runtime/contracts";
import { formatDurationMs } from "@services/runtime/format";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import { useUpdateEnvironmentSettings } from "@services/runtime/queries";
import { cn } from "src/core/utils/components";

// Machines the environment's cell keeps ready from its last bake, so a PR's
// Run starts on one instead of booting its own. The plan sets the default
// and the ceiling; the org owner picks how many and when: all the time, in
// working hours, after pull request activity, under a monthly budget.

const machines = (n: number) => `${n} machine${n === 1 ? "" : "s"}`;
const usd = (n: number) =>
    n.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: n < 10 ? 2 : 0,
    });

const DAYS: Array<{ value: PoolWeekday; label: string }> = [
    { value: "mon", label: "Mon" },
    { value: "tue", label: "Tue" },
    { value: "wed", label: "Wed" },
    { value: "thu", label: "Thu" },
    { value: "fri", label: "Fri" },
    { value: "sat", label: "Sat" },
    { value: "sun", label: "Sun" },
];

type When = "always" | "schedule" | "pull_request";

const WHEN_OPTIONS: Array<[When, string, string]> = [
    [
        "always",
        "All the time",
        "Ready day and night. Fastest, and the most expensive.",
    ],
    [
        "schedule",
        "Working hours",
        "Ready only on the days and hours you choose.",
    ],
    [
        "pull_request",
        "After pull request activity",
        "Off until a pull request opens or gets a push, then ready for a while.",
    ],
];

const whenOf = (value: string): When | undefined =>
    WHEN_OPTIONS.find(([v]) => v === value)?.[0];

const REASON_TEXT: Record<PoolReason, string> = {
    off: "the pool is off",
    always: "all the time",
    schedule: "inside working hours",
    outside_schedule: "outside working hours",
    pull_request: "warm after a pull request",
    idle: "no pull request lately",
    budget: "this month's budget is spent",
};

const browserTimeZone = () => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
};

const timeZones = (current: string) => {
    let all: string[] = [];
    try {
        all =
            (
                Intl as unknown as {
                    supportedValuesOf?: (k: string) => string[];
                }
            ).supportedValuesOf?.("timeZone") ?? [];
    } catch {
        all = [];
    }
    return all.includes(current) ? all : [current, ...all];
};

/** The form's draft of the policy, with defaults for the parts not chosen yet. */
const draftOf = (policy: PoolPolicy | null | undefined) => ({
    when: (policy?.schedule
        ? "schedule"
        : policy?.onPullRequest
          ? "pull_request"
          : "always") as When,
    days:
        policy?.schedule?.days ??
        (["mon", "tue", "wed", "thu", "fri"] as PoolWeekday[]),
    start: policy?.schedule?.start ?? "08:00",
    end: policy?.schedule?.end ?? "19:00",
    timezone: policy?.schedule?.timezone ?? browserTimeZone(),
    warmOnPr: !!policy?.onPullRequest,
    idleMinutes: String(policy?.onPullRequest?.idleMinutes ?? 60),
    budget:
        policy?.monthlyBudgetUsd !== undefined
            ? String(policy.monthlyBudgetUsd)
            : "",
});
type Draft = ReturnType<typeof draftOf>;

/** The policy the draft describes, or the first thing wrong with it. */
const policyOf = (
    d: Draft,
): { policy: PoolPolicy | null } | { error: string } => {
    const out: PoolPolicy = {};
    if (d.when === "schedule") {
        if (!d.days.length) return { error: "Pick at least one day." };
        if (d.start === d.end)
            return { error: "Start and end are the same time." };
        out.schedule = {
            timezone: d.timezone,
            days: DAYS.map((x) => x.value).filter((v) => d.days.includes(v)),
            start: d.start,
            end: d.end,
        };
    }
    if (d.when === "pull_request" || (d.when === "schedule" && d.warmOnPr)) {
        const m = Number(d.idleMinutes);
        if (!Number.isInteger(m) || m < 10 || m > 1440)
            return { error: "Minutes after a pull request: 10 to 1440." };
        out.onPullRequest = { idleMinutes: m };
    }
    if (d.budget.trim() !== "") {
        const b = Number(d.budget);
        if (!Number.isFinite(b) || b <= 0)
            return { error: "The budget is an amount above 0, or empty." };
        out.monthlyBudgetUsd = b;
    }
    return { policy: Object.keys(out).length ? out : null };
};

const same = (a: unknown, b: unknown) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

type DraftProps = { draft: Draft; set: (patch: Partial<Draft>) => void };

/** The days, hours and time zone of "Working hours", under its option. */
const ScheduleFields = ({
    draft,
    set,
    zones,
}: DraftProps & { zones: string[] }) => (
    <div className="border-card-lv3 ml-6 flex flex-col gap-3 border-l pl-4">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Days">
            {DAYS.map((d) => {
                const on = draft.days.includes(d.value);
                return (
                    <button
                        key={d.value}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                            set({
                                days: on
                                    ? draft.days.filter((x) => x !== d.value)
                                    : [...draft.days, d.value],
                            })
                        }
                        className={cn(
                            "focus-visible:ring-ring rounded-md px-2.5 py-1 text-xs hover:brightness-120 focus-visible:ring-3 focus-visible:outline-none",
                            on
                                ? "bg-primary-light/15 text-primary-light"
                                : "bg-card-lv2 text-text-secondary",
                        )}>
                        {d.label}
                    </button>
                );
            })}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-text-secondary">From</span>
            <div className="w-32">
                <Input
                    type="time"
                    aria-label="Ready from"
                    value={draft.start}
                    onChange={(e) => set({ start: e.target.value })}
                />
            </div>
            <span className="text-text-secondary">to</span>
            <div className="w-32">
                <Input
                    type="time"
                    aria-label="Ready until"
                    value={draft.end}
                    onChange={(e) => set({ end: e.target.value })}
                />
            </div>
            <select
                aria-label="Time zone"
                value={draft.timezone}
                onChange={(e) => set({ timezone: e.target.value })}
                className="bg-card-lv2 text-text-primary ring-card-lv3 focus-visible:ring-ring h-10 max-w-64 rounded-xl px-3 text-sm ring-1 focus-visible:ring-3 focus-visible:outline-none">
                {zones.map((z) => (
                    <option key={z} value={z}>
                        {z}
                    </option>
                ))}
            </select>
        </div>
        {draft.end < draft.start && (
            <p className="text-text-tertiary text-xs">
                Ends after midnight, on the next day.
            </p>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
                type="checkbox"
                checked={draft.warmOnPr}
                onChange={(e) => set({ warmOnPr: e.target.checked })}
                className="accent-primary-light"
            />
            <span className="text-text-secondary">
                Outside these hours, also warm up after pull request activity
            </span>
        </label>
    </div>
);

/** How long machines stay ready after pull request activity. */
const WarmUpMinutes = ({ draft, set }: DraftProps) => (
    <div className="ml-6 flex flex-wrap items-center gap-2 pl-4 text-sm">
        <span className="text-text-secondary">Keep them ready for</span>
        <div className="w-24">
            <Input
                type="number"
                min={10}
                max={1440}
                step={5}
                aria-label="Minutes after a pull request"
                value={draft.idleMinutes}
                onChange={(e) => set({ idleMinutes: e.target.value })}
            />
        </div>
        <span className="text-text-secondary">
            minutes after the last pull request event.
        </span>
        <p className="text-text-tertiary basis-full text-xs">
            The pull request that wakes the pool boots its own machines; the
            pushes after it find them ready.
        </p>
    </div>
);

export const WarmPool = ({
    environmentId,
    pool,
    canEdit,
    hasBake = true,
    bootP50Ms,
}: {
    environmentId: string;
    pool: EnvironmentPool;
    canEdit: boolean;
    /** The environment has a setup that booted: the pool's machines come from it. */
    hasBake?: boolean;
    /** The environment's time to ready today: what a ready machine saves a Run. */
    bootP50Ms?: number;
}) => {
    // Remounted with a new `key` when the saved values change.
    const [size, setSize] = useState(
        pool.setting != null ? String(pool.setting) : "",
    );
    const [draft, setDraft] = useState(() => draftOf(pool.policy));
    const set = (patch: Partial<Draft>) =>
        setDraft((d) => ({ ...d, ...patch }));
    const update = useUpdateEnvironmentSettings();
    const whenLegendId = useId();

    const parsedSize = size.trim() === "" ? null : Number(size);
    const sizeValid =
        parsedSize === null ||
        (Number.isInteger(parsedSize) &&
            parsedSize >= 0 &&
            parsedSize <= pool.maxSize);
    const built = policyOf(draft);
    const policyError = "error" in built ? built.error : undefined;
    const policy = "policy" in built ? built.policy : undefined;
    const sizeDirty = pool.setting !== parsedSize;
    const policyDirty = policy !== undefined && !same(policy, pool.policy);
    const valid = sizeValid && !policyError;

    if (pool.maxSize === 0) {
        return (
            <p className="text-text-secondary text-sm">
                Your plan keeps no machines ready. Each Run boots its own.
            </p>
        );
    }

    const save = (body: {
        poolSize?: number | null;
        poolPolicy?: PoolPolicy | null;
    }) =>
        update.mutate(
            { environmentId, ...body },
            {
                onSuccess: () =>
                    toast({ variant: "success", title: "Warm pool saved" }),
                onError: (error) =>
                    toast({
                        variant: "danger",
                        title: "Couldn't save the warm pool",
                        description: runtimeErrorMessage(error, {
                            fallback: "Try again in a moment.",
                            403: "Only the owner of the organization can change it.",
                        }),
                    }),
            },
        );

    const nowSize = pool.now?.size ?? pool.size;
    const estimate = pool.estimate;
    const zones = timeZones(draft.timezone);
    const asksMinutes =
        draft.when === "pull_request" ||
        (draft.when === "schedule" && draft.warmOnPr);

    return (
        <div className="flex flex-col gap-5">
            <p className="text-sm" aria-live="polite">
                {nowSize > 0 ? (
                    <>
                        Keeping <strong>{machines(nowSize)}</strong> ready now
                    </>
                ) : (
                    <>
                        <strong>No machines</strong> ready now
                    </>
                )}
                {pool.now ? ` (${REASON_TEXT[pool.now.reason]})` : ""}
                {pool.setting === null ? ", at the plan's default size" : ""}.
            </p>
            {!hasBake && (
                <p className="text-warning text-sm">
                    The machines come from the last setup that booted. This
                    environment has none yet, so nothing is kept ready until a
                    setup boots.
                </p>
            )}

            <form
                className="flex flex-col gap-5"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (!valid || (!sizeDirty && !policyDirty)) return;
                    save({
                        ...(sizeDirty ? { poolSize: parsedSize } : {}),
                        ...(policyDirty ? { poolPolicy: policy } : {}),
                    });
                }}>
                <fieldset className="flex flex-col gap-2" disabled={!canEdit}>
                    <legend className="text-text-primary mb-1 text-sm font-medium">
                        How many
                    </legend>
                    <div className="flex flex-wrap items-center gap-3">
                        {/* Input's wrapper grows (flex-1): a fixed-width box keeps the field short. */}
                        <div className="w-56">
                            <Input
                                type="number"
                                min={0}
                                max={pool.maxSize}
                                step={1}
                                inputMode="numeric"
                                aria-label="Machines kept ready"
                                aria-invalid={!sizeValid}
                                placeholder={`Plan default (${pool.defaultSize})`}
                                value={size}
                                onChange={(event) =>
                                    setSize(event.target.value)
                                }
                            />
                        </div>
                        <span className="text-text-tertiary text-sm">
                            up to {pool.maxSize} on your plan
                        </span>
                    </div>
                    {!sizeValid && (
                        <p className="text-danger text-sm" role="alert">
                            A whole number from 0 to {pool.maxSize}.
                        </p>
                    )}
                </fieldset>

                <fieldset className="flex flex-col gap-2" disabled={!canEdit}>
                    <legend
                        id={whenLegendId}
                        className="text-text-primary mb-1 text-sm font-medium">
                        When
                    </legend>
                    {/* The fieldset disables the nested schedule controls; the
                        group's own `disabled` gives its radios Radix's state. */}
                    <RadioGroup.Root
                        aria-labelledby={whenLegendId}
                        value={draft.when}
                        onValueChange={(value) => {
                            const when = whenOf(value);
                            if (when) set({ when });
                        }}
                        disabled={!canEdit}
                        className="gap-2">
                        {WHEN_OPTIONS.map(([value, label, hint]) => (
                            <Fragment key={value}>
                                <Label className="flex cursor-pointer items-start gap-3 text-sm leading-snug">
                                    <RadioGroup.Item
                                        value={value}
                                        className="mt-0.5"
                                    />
                                    <span className="flex flex-col gap-0.5">
                                        <span className="text-text-primary">
                                            {label}
                                        </span>
                                        <span className="text-text-secondary text-xs font-normal">
                                            {hint}
                                        </span>
                                    </span>
                                </Label>
                                {value === "schedule" &&
                                    draft.when === "schedule" && (
                                        <ScheduleFields
                                            draft={draft}
                                            set={set}
                                            zones={zones}
                                        />
                                    )}
                                {value === draft.when && asksMinutes && (
                                    <WarmUpMinutes draft={draft} set={set} />
                                )}
                            </Fragment>
                        ))}
                    </RadioGroup.Root>
                </fieldset>

                <fieldset className="flex flex-col gap-2" disabled={!canEdit}>
                    <legend className="text-text-primary mb-1 text-sm font-medium">
                        Monthly budget
                    </legend>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-text-secondary">US$</span>
                        <div className="w-32">
                            <Input
                                type="number"
                                min={1}
                                step={1}
                                aria-label="Monthly budget in US dollars"
                                placeholder="No limit"
                                value={draft.budget}
                                onChange={(e) =>
                                    set({ budget: e.target.value })
                                }
                            />
                        </div>
                        <span className="text-text-tertiary">
                            Stop keeping machines once this month&apos;s
                            estimate reaches it.
                        </span>
                    </div>
                </fieldset>

                {policyError && (
                    <p className="text-danger text-sm" role="alert">
                        {policyError}
                    </p>
                )}

                <div className="flex flex-wrap items-center gap-3">
                    <Button
                        type="submit"
                        size="md"
                        variant="primary"
                        disabled={
                            !canEdit || !valid || (!sizeDirty && !policyDirty)
                        }
                        loading={update.isPending}>
                        Save
                    </Button>
                    {pool.setting !== null && (
                        <Button
                            type="button"
                            size="md"
                            variant="cancel"
                            disabled={!canEdit || update.isPending}
                            onClick={() => save({ poolSize: null })}>
                            Use the plan&apos;s default
                        </Button>
                    )}
                </div>
            </form>

            <div className="bg-card-lv2 flex flex-col gap-1 rounded-lg p-4 text-sm">
                <p className="text-text-primary font-medium">
                    What it buys and what it costs
                </p>
                <p className="text-text-secondary">
                    A Run that finds a ready machine skips the boot
                    {bootP50Ms !== undefined
                        ? `, about ${formatDurationMs(bootP50Ms)} on this environment today`
                        : ""}
                    .
                </p>
                {estimate && pool.usdPerMachineHour !== undefined && (
                    <p className="text-text-secondary">
                        {estimate.usd === null
                            ? `It depends on pull request activity: ${usd(pool.usdPerMachineHour)} per machine-hour at list price.`
                            : estimate.usd === 0
                              ? "Nothing is kept ready, so it costs nothing."
                              : `At most about ${usd(estimate.usd)} a month at list price (${machines(pool.size)} × ${estimate.hours} h × ${usd(pool.usdPerMachineHour)}).`}
                        {pool.spentUsd !== undefined &&
                            ` This month so far: ${usd(pool.spentUsd)}.`}
                    </p>
                )}
                <p className="text-text-tertiary text-xs">
                    Ready machines keep running while they wait. They come from
                    the environment&apos;s last setup, and a new setup replaces
                    them. A saved change goes to the host right away; the
                    schedule is checked every 5 minutes.
                    {!canEdit &&
                        " Only the owner of the organization can change it."}
                </p>
            </div>
        </div>
    );
};
