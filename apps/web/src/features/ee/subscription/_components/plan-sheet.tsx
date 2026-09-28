"use client";

/* Hallmark · component: plan sheet (subscription page) · genre: modern-minimal · theme: Kodus system tokens (card-lv*, text-*, plan tones)
 * redesign: a card per status with a red eyebrow over a hard-coded "PRO plan" → one sheet for every state: tier chip, the plan's real name, one honest sentence, the one action that state needs, then the facts billing gives
 * states: default · warning (trial or license ending) · error (payment failed, canceled, expired, license expired) · unknown (billing unreachable) · action loading · action disabled (no billing permission)
 * contrast: pass (40–41) · tokens: pass (48) · honest: pass (46 — seats, days, members from billing and the API only) · responsive: action and facts stack < sm
 * pre-emit critique: P4 H5 E4 S4 R5 V4
 */
import { Heading } from "@components/ui/heading";
import { cn } from "src/core/utils/components";

import {
    PLAN_BAR_TONE,
    PLAN_BORDER_TONE,
    PLAN_CHIP_TONE,
    type PlanTone,
} from "../_utils/plan-tone";

/**
 * The plan at the top of the subscription page. Same chip and tones as the
 * sidebar's plan panel, so the page reads as the place that panel opens.
 */
export const PlanSheet = ({
    tone,
    chip,
    title,
    summary,
    summaryClassName,
    actions,
    facts,
    children,
}: React.PropsWithChildren<{
    tone: PlanTone;
    chip: string;
    title: string;
    summary?: React.ReactNode;
    summaryClassName?: string;
    /** The state's one primary action, plus at most one secondary. */
    actions?: React.ReactNode;
    facts?: React.ReactNode;
}>) => (
    <section
        aria-label="Plan"
        className={cn(
            "bg-card-lv1 flex w-full flex-col rounded-2xl border",
            PLAN_BORDER_TONE[tone],
        )}>
        <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-col gap-2">
                <span
                    className={cn(
                        "w-fit rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide whitespace-nowrap uppercase",
                        PLAN_CHIP_TONE[tone],
                    )}>
                    {chip}
                </span>
                <Heading variant="h2" className="[overflow-wrap:anywhere]">
                    {title}
                </Heading>
                {summary && (
                    <p
                        className={cn(
                            "text-text-secondary max-w-xl text-sm text-pretty",
                            summaryClassName,
                        )}>
                        {summary}
                    </p>
                )}
            </div>
            {actions && (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {actions}
                </div>
            )}
        </div>

        {facts && (
            <dl className="border-card-lv3/60 grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-x-8 gap-y-5 border-t px-6 py-5">
                {facts}
            </dl>
        )}

        {children && (
            <div className="border-card-lv3/60 border-t px-6 py-5">
                {children}
            </div>
        )}
    </section>
);

export const PlanFact = ({
    label,
    value,
    detail,
    detailClassName,
    meter,
}: {
    label: string;
    value: React.ReactNode;
    detail?: React.ReactNode;
    detailClassName?: string;
    /** 0–1 share with the tone of the bar, e.g. seats in use. */
    meter?: { share: number; tone: PlanTone };
}) => (
    <div className="flex min-w-0 flex-col gap-1.5">
        <dt className="text-text-tertiary text-xs">{label}</dt>
        <dd className="text-text-primary text-lg font-semibold tabular-nums">
            {value}
        </dd>
        {meter && (
            <dd
                className="bg-card-lv3 block h-1 max-w-48 overflow-hidden rounded-full"
                aria-hidden>
                <span
                    className={cn(
                        "block h-full rounded-full",
                        PLAN_BAR_TONE[meter.tone],
                    )}
                    style={{
                        width: `${Math.min(1, Math.max(0, meter.share)) * 100}%`,
                    }}
                />
            </dd>
        )}
        {detail && (
            <dd
                className={cn(
                    "text-text-tertiary text-xs text-pretty",
                    detailClassName,
                )}>
                {detail}
            </dd>
        )}
    </div>
);

export const SeatsFact = ({
    used,
    total,
    tone,
}: {
    used: number;
    total: number;
    tone: PlanTone;
}) => (
    <PlanFact
        label="Seats in use"
        value={`${used} of ${total}`}
        meter={total > 0 ? { share: used / total, tone } : undefined}
        detail="People whose pull requests Kody reviews."
    />
);
