"use client";

import { useState, type ReactNode } from "react";
import NextLink from "next/link";
import { TONE_TEXT_CLASS } from "@components/runtime/status-chip";
import { Card } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Skeleton } from "@components/ui/skeleton";
import type {
    RuntimeEnvironment,
    RuntimeMode,
    RuntimeRunSummary,
} from "@services/runtime/contracts";
import { formatDurationMs } from "@services/runtime/format";
import {
    environmentBootMs,
    environmentStatus,
} from "@services/runtime/model/environment";
import {
    BoxesIcon,
    CircleAlertIcon,
    CircleCheckIcon,
    CircleDashedIcon,
    FlaskConicalIcon,
    MessageSquareTextIcon,
    TimerIcon,
} from "lucide-react";

const DAY = 24 * 3_600_000;

/** Screen 2, top line: is it working, how fast it boots, what it found. */
export const RuntimeStatusStrip = ({
    mode,
    environment,
    environmentsError,
    runs,
    isLoading,
}: {
    mode: RuntimeMode;
    environment?: RuntimeEnvironment;
    environmentsError?: boolean;
    runs?: RuntimeRunSummary[] | null;
    isLoading: boolean;
}) => {
    // The 30-day window is fixed when the strip mounts, not at every render.
    const [since] = useState(() => Date.now() - 30 * DAY);
    if (isLoading) return <Skeleton className="h-12 w-full rounded-xl" />;
    const status = environmentStatus(environment);
    const recent = (runs ?? []).filter(
        (r) => Date.parse(r.requestedAt) >= since,
    );
    const regressions = recent.filter(
        (r) => r.verdictState === "regression",
    ).length;
    const boot = environmentBootMs(environment);
    const Icon =
        status.tone === "success"
            ? CircleCheckIcon
            : status.tone === "danger" || status.tone === "warning"
              ? CircleAlertIcon
              : CircleDashedIcon;
    return (
        <Card
            color="lv1"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 px-5 py-3.5 text-sm">
            <Icon
                className={`size-4 ${TONE_TEXT_CLASS[status.tone]}`}
                aria-hidden
            />
            <span className="text-text-primary font-medium">
                {mode === "off" ? "Off" : status.label}
            </span>
            {environmentsError ? (
                <span className="text-text-secondary">
                    Couldn&apos;t load the environment of this repository.
                </span>
            ) : environment ? (
                <span className="text-text-secondary">
                    {[
                        boot !== undefined &&
                            `Environment boots in ${formatDurationMs(boot)}`,
                        `${recent.length} ${recent.length === 1 ? "run" : "runs"} in 30 days`,
                        regressions > 0 &&
                            `${regressions} ${regressions === 1 ? "regression" : "regressions"}`,
                    ]
                        .filter(Boolean)
                        .join(" · ")}
                </span>
            ) : (
                <span className="text-text-secondary">
                    No environment for this repository yet.{" "}
                    <NextLink
                        href="/runtime/environments"
                        className="text-primary-light hover:underline">
                        Set it up
                    </NextLink>
                </span>
            )}
        </Card>
    );
};

const Line = ({
    icon,
    children,
    note,
}: {
    icon: ReactNode;
    children: ReactNode;
    note?: ReactNode;
}) => (
    <li className="flex gap-3">
        <span
            aria-hidden
            className="text-text-tertiary mt-0.5 shrink-0 [&_svg]:size-4">
            {icon}
        </span>
        <div className="flex min-w-0 flex-col">
            <span className="text-text-primary text-sm">{children}</span>
            {note && (
                <span className="text-text-secondary text-xs">{note}</span>
            )}
        </div>
    </li>
);

/** The settings on the left read back as what Kody does, one line per step. */
export const RuntimeHowItWorks = ({
    mode,
    rulesCount,
    environment,
}: {
    mode: RuntimeMode;
    rulesCount: number;
    environment?: RuntimeEnvironment;
}) => {
    const services = environment?.setup?.expose?.map((e) => e.service) ?? [];
    return (
        <Card color="lv1" className="flex flex-col gap-3 px-5 py-4">
            <Heading variant="h3" className="text-sm">
                How it works
            </Heading>
            <ol className="flex flex-col gap-3">
                <Line
                    icon={<TimerIcon />}
                    note={
                        mode === "off"
                            ? undefined
                            : "With focus: @kody runtime check refunds"
                    }>
                    {mode === "off"
                        ? "Never runs on this repository"
                        : mode === "rules"
                          ? `Runs when a PR matches ${rulesCount === 1 ? "the rule" : `one of ${rulesCount} rules`}, or someone comments @kody runtime`
                          : "Runs when someone comments @kody runtime"}
                </Line>
                <Line
                    icon={<BoxesIcon />}
                    note={
                        services.length
                            ? `Services: ${services.join(", ")}`
                            : "From the environment of this repository"
                    }>
                    Boots this repository and what it needs
                </Line>
                <Line
                    icon={<FlaskConicalIcon />}
                    note="Uses test data and supported fakes">
                    Runs the PR and compares it with the base version
                </Line>
                <Line
                    icon={<MessageSquareTextIcon />}
                    note="The machine is destroyed when done">
                    Posts the result and available evidence, and replies on the
                    review suggestions it confirms
                </Line>
            </ol>
        </Card>
    );
};

const CHECKS = [
    [
        "The PR boots",
        "Build, migrations and startup. A crash caused by the PR is a regression.",
    ],
    [
        "Behavior changes",
        "The same request on main and on the PR. A different result is a regression.",
    ],
    [
        "The tests that cover the change",
        "Picks the tests related to the diff and runs them on both sides.",
    ],
] as const;

/** What the Runtime checks today (read-only: the Run does all three). */
export const WhatKodyChecks = () => (
    <section className="flex flex-col gap-3" aria-labelledby="what-kody-checks">
        <div className="flex flex-col gap-1">
            <Heading variant="h3" id="what-kody-checks">
                What Kody checks
            </Heading>
            <p className="text-text-secondary text-sm">
                The same reading as the review, now proved by running it.
            </p>
        </div>
        <ul className="bg-card-lv1 divide-card-lv3/60 flex flex-col divide-y rounded-xl">
            {CHECKS.map(([title, hint]) => (
                <li key={title} className="flex items-start gap-3 px-4 py-3">
                    <CircleCheckIcon
                        className="text-success mt-0.5 size-4 shrink-0"
                        aria-hidden
                    />
                    <div className="flex flex-col gap-0.5">
                        <span className="text-text-primary text-sm font-medium">
                            {title}
                        </span>
                        <span className="text-text-secondary text-xs">
                            {hint}
                        </span>
                    </div>
                </li>
            ))}
        </ul>
        {/* S1-03: what a branch protection that requires the check lets
            through (owner decision of 2026-11-18: a partly tested Run with
            something left to decide is action_required). */}
        <p className="text-text-secondary text-xs">
            On GitHub the &ldquo;Kody Runtime&rdquo; check fails on a
            regression. It asks for action when the Run was partly tested and
            left a finding it could not settle, or could not boot because the
            egress proxy denied a host: a required check then blocks the merge
            until the Run is run again or the finding is accepted on its Run
            page. Only a Run with nothing to test ends neutral, which a
            required check lets through. On Forgejo a neutral Run posts a
            &ldquo;warning&rdquo; status: check how your branch protection
            treats it.
        </p>
    </section>
);
