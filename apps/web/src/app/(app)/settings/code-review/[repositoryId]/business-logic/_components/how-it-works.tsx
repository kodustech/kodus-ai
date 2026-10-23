"use client";

import type { ReactNode } from "react";
import { Card } from "@components/ui/card";
import { useTaskSources } from "@services/business-logic/hooks";
import {
    FileSearchIcon,
    ListChecksIcon,
    MessageSquareTextIcon,
    TimerIcon,
} from "lucide-react";
import { useFormContext, useWatch } from "react-hook-form";

import type { CodeReviewFormType } from "../../../_types";

const WHEN: Record<string, string> = {
    request: "First review, then only on @kody -v business-logic",
    failing: "First review, then each push until it passes",
    push: "First review, then every push",
};

const Line = ({
    icon,
    label,
    children,
    note,
}: {
    icon: ReactNode;
    label: string;
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
            <span className="sr-only">{label}: </span>
            <span className="text-text-primary text-sm">{children}</span>
            {note && (
                <span className="text-text-secondary text-xs">{note}</span>
            )}
        </div>
    </li>
);

/**
 * The settings on the left, read back as what Kody does, one line per step.
 * It follows the form, saved or not, so a combination reads as its outcome
 * before anyone saves it.
 */
export const HowItWorks = ({ teamId }: { teamId: string }) => {
    const form = useFormContext<CodeReviewFormType>();
    const settings = useWatch({
        control: form.control,
        name: "businessLogic" as never,
    }) as Record<string, { value?: unknown } | undefined> | undefined;
    const value = <T,>(name: string) =>
        settings?.[name]?.value as T | undefined;
    const taskSource = value<string>("taskSource") ?? "auto";
    const location = value<string>("criteriaLocation") ?? "auto";
    const heading = value<string>("criteriaHeading")?.trim();
    const field = value<string>("criteriaField")?.trim();
    const guidance = !!value<string>("teamGuidance")?.trim();
    const commentWhenMet = value<boolean>("commentWhenMet") ?? true;
    const requireTask = value<boolean>("requireTask") ?? false;
    const recheckOn = value<string>("recheckOn") ?? "request";
    const { data: sources } = useTaskSources(teamId);

    const autoNames = (sources ?? [])
        .filter((s) => s.inAuto ?? s.kind === "managed")
        .map((s) => s.name);
    const source =
        taskSource === "auto"
            ? autoNames.join(", ") || "every connected tracker"
            : (sources?.find((s) => s.integrationId === taskSource)?.name ??
              "the picked tracker");
    const criteria =
        location === "heading"
            ? `Criteria under “${heading || "…"}”`
            : location === "field"
              ? `Criteria in the “${field || "…"}” field`
              : "Criteria field, checklist or list";

    return (
        <Card color="lv1" className="flex flex-col gap-3 px-5 py-4">
            <span className="text-text-primary text-sm font-medium">
                With these settings
            </span>
            <ul className="flex flex-col gap-3">
                <Line
                    icon={<TimerIcon />}
                    label="When"
                    note={
                        recheckOn === "request"
                            ? undefined
                            : "@kody -v business-logic checks any time, even a skipped PR"
                    }>
                    {WHEN[recheckOn] ?? WHEN.request}
                </Line>
                <Line
                    icon={<FileSearchIcon />}
                    label="Task"
                    note={
                        requireTask
                            ? "No task named: Kody asks for one"
                            : "No task named: skipped, no comment"
                    }>
                    Task from title, branch or description, read in {source}
                </Line>
                <Line
                    icon={<ListChecksIcon />}
                    label="Requirements"
                    note={guidance ? "Plus your team guidance" : undefined}>
                    {criteria}
                </Line>
                <Line
                    icon={<MessageSquareTextIcon />}
                    label="Comment"
                    note={
                        commentWhenMet
                            ? "A short note when all is met"
                            : "Nothing posted when all is met"
                    }>
                    One comment, updated on each check
                </Line>
            </ul>
        </Card>
    );
};
