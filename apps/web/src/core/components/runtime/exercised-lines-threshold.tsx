"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import { toast } from "@components/ui/toaster/use-toast";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    exercisedThresholdDraft,
    exercisedThresholdWords,
} from "@services/runtime/model/exercised-lines-threshold";
import { useUpdateRuntimeOrgSettings } from "@services/runtime/queries";

const ERROR_ID = "org-exercised-threshold-error";

/**
 * The org's exercised-lines threshold: which one holds, and an admin's field
 * to set the org's own (0 to 100) or go back to the deployment's default.
 * Remount with a `key` of the saved `value` so the field follows what was saved.
 */
export const ExercisedLinesThreshold = ({
    value,
    defaultPercent,
    canEdit,
}: {
    value: number | null;
    defaultPercent: number;
    canEdit: boolean;
}) => {
    const [draft, setDraft] = useState(value !== null ? String(value) : "");
    const update = useUpdateRuntimeOrgSettings();
    const { percent, error } = exercisedThresholdDraft(draft);
    const canSave = canEdit && !error && percent !== null && percent !== value;

    const send = (next: number | null) =>
        update.mutate(
            { exercisedLinesThresholdPercent: next },
            {
                onSuccess: () => {
                    if (next === null) setDraft("");
                    toast({
                        variant: "success",
                        title:
                            next === null
                                ? "Back to the default threshold"
                                : "Threshold saved",
                        description:
                            "New Runs use it; a Run already started keeps the value it started with.",
                    });
                },
                onError: (e) =>
                    toast({
                        variant: "danger",
                        title: "Couldn't save the threshold",
                        description: runtimeErrorMessage(e, {
                            fallback: "Try again in a moment.",
                        }),
                    }),
            },
        );

    return (
        <div className="flex flex-col gap-2">
            <p className="text-text-primary text-sm">
                {exercisedThresholdWords(value, defaultPercent)}
            </p>
            <form
                className="flex flex-wrap items-center gap-3"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (canSave) send(percent);
                }}>
                {/* Input's wrapper grows (flex-1): a fixed-width box keeps the field short. */}
                <div className="w-56">
                    <Input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        inputMode="numeric"
                        aria-label="Share of changed lines that must run"
                        aria-invalid={!!error}
                        aria-describedby={error ? ERROR_ID : undefined}
                        placeholder={`${defaultPercent} (the default)`}
                        value={draft}
                        disabled={!canEdit}
                        onChange={(event) => setDraft(event.target.value)}
                    />
                </div>
                <span className="text-text-tertiary text-sm">
                    % of changed lines
                </span>
                <Button
                    type="submit"
                    size="md"
                    variant="primary"
                    disabled={!canSave}
                    loading={update.isPending}>
                    Save
                </Button>
                {value !== null && (
                    <Button
                        type="button"
                        size="md"
                        variant="cancel"
                        disabled={!canEdit || update.isPending}
                        onClick={() => send(null)}>
                        Use the default
                    </Button>
                )}
            </form>
            {error && (
                <p id={ERROR_ID} role="alert" className="text-danger text-xs">
                    {error}
                </p>
            )}
            <p className="text-text-tertiary text-xs">
                After its checks, Kody counts how many of the pull
                request&apos;s changed lines ran. When a Run finds no regression
                but fewer than this share ran, Kody marks it Partly tested
                instead of No regressions and says how many ran. 0 never changes
                the verdict. Leave it empty to use the default.
            </p>
            {!canEdit && (
                <p className="text-text-tertiary text-xs">
                    Only organization admins can change this.
                </p>
            )}
        </div>
    );
};
