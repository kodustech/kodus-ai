"use client";

import { Button } from "@components/ui/button";
import type { KodyRuleAutoPause } from "@services/kodyRules/types";
import { PlayIcon } from "lucide-react";

const DAY_MS = 24 * 60 * 60 * 1000;

const formatDate = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
    });
};

const windowDays = (autoPause: KodyRuleAutoPause) =>
    Math.max(
        1,
        Math.round(
            (new Date(autoPause.windowEnd).getTime() -
                new Date(autoPause.windowStart).getTime()) /
                DAY_MS,
        ),
    );

/** Why Kody paused the rule, with the numbers behind it. */
export const autoPauseReason = (autoPause: KodyRuleAutoPause): string => {
    const window = `in the last ${windowDays(autoPause)} days`;
    return autoPause.state === "noisy"
        ? `Developers downvoted it: ${autoPause.thumbsDown} 👎 and ${autoPause.thumbsUp} 👍 on ${autoPause.triggers} suggestions ${window}.`
        : `Developers ignored it: ${autoPause.implemented} of ${autoPause.triggers} suggestions implemented ${window}.`;
};

export const autoPauseTitle = (autoPause: KodyRuleAutoPause): string => {
    const date = formatDate(autoPause.pausedAt);
    return `Paused by Kody${date ? ` on ${date}` : ""}. ${autoPauseReason(autoPause)} It is skipped on new reviews until you resume it.`;
};

export const AutoPauseNotice = ({
    autoPause,
    canResume,
    resuming,
    onResume,
}: {
    autoPause: KodyRuleAutoPause;
    canResume: boolean;
    resuming: boolean;
    onResume: () => void;
}) => {
    const date = formatDate(autoPause.pausedAt);
    return (
        <div className="border-warning/40 bg-warning/10 flex flex-col gap-3 rounded-lg border p-4">
            <div className="flex flex-col gap-1">
                <p className="text-text-primary text-sm font-semibold">
                    Paused by Kody{date ? ` on ${date}` : ""}
                </p>
                <p className="text-text-secondary text-sm">
                    {autoPauseReason(autoPause)} It is skipped on new reviews
                    until you resume it. If it pauses again, only what it flags
                    after the resume counts.
                </p>
            </div>
            {canResume && (
                <Button
                    size="sm"
                    variant="helper"
                    className="self-start"
                    leftIcon={<PlayIcon />}
                    loading={resuming}
                    disabled={resuming}
                    onClick={onResume}>
                    Resume
                </Button>
            )}
        </div>
    );
};
