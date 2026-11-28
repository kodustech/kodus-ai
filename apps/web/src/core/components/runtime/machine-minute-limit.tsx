"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import { toast } from "@components/ui/toaster/use-toast";
import type { RuntimeMachineMinutesToday } from "@services/runtime/contracts";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    machineMinuteLimitWords,
    orgMachineMinuteLimitDraft,
} from "@services/runtime/model/machine-minutes";
import { useUpdateRuntimeMachineMinutes } from "@services/runtime/queries";

const ERROR_ID = "org-machine-minutes-error";

/**
 * The org's own daily machine minutes: which limit holds the org today, and an admin's
 * field to lower the deployment's (never raise it) or remove the org's own.
 * Remount with a `key` of the saved `orgLimitMinutes` so the field follows what was saved.
 */
export const MachineMinuteLimit = ({
    today,
    canEdit,
}: {
    today: RuntimeMachineMinutesToday;
    canEdit: boolean;
}) => {
    const saved = today.orgLimitMinutes;
    const [draft, setDraft] = useState(saved !== null ? String(saved) : "");
    const update = useUpdateRuntimeMachineMinutes();
    const { minutesPerDay, error } = orgMachineMinuteLimitDraft(
        draft,
        today.deploymentLimitMinutes,
    );
    const canSave =
        canEdit && minutesPerDay !== null && minutesPerDay !== saved;

    const send = (value: number | null) =>
        update.mutate(
            { minutesPerDay: value },
            {
                onSuccess: () => {
                    if (value === null) setDraft("");
                    toast({
                        variant: "success",
                        title:
                            value === null
                                ? "Organization limit removed"
                                : "Machine-minute limit saved",
                        description:
                            "Kodus applies it from the next machine it starts.",
                    });
                },
                onError: (e) =>
                    toast({
                        variant: "danger",
                        title: "Couldn't save the machine-minute limit",
                        description: runtimeErrorMessage(e, {
                            fallback: "Try again in a moment.",
                        }),
                    }),
            },
        );

    return (
        <div className="flex flex-col gap-2">
            <p className="text-text-primary text-sm">
                {machineMinuteLimitWords(today)}
            </p>
            <form
                className="flex flex-wrap items-center gap-3"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (canSave) send(minutesPerDay);
                }}>
                {/* Input's wrapper grows (flex-1): a fixed-width box keeps the field short. */}
                <div className="w-56">
                    <Input
                        type="number"
                        min={1}
                        max={today.deploymentLimitMinutes ?? undefined}
                        step={1}
                        inputMode="numeric"
                        aria-label="Your organization's machine minutes per day"
                        aria-invalid={!!error}
                        aria-describedby={error ? ERROR_ID : undefined}
                        placeholder={
                            today.deploymentLimitMinutes !== null
                                ? `${today.deploymentLimitMinutes.toLocaleString("en-US")} (the deployment's)`
                                : "No limit"
                        }
                        value={draft}
                        disabled={!canEdit}
                        onChange={(event) => setDraft(event.target.value)}
                    />
                </div>
                <span className="text-text-tertiary text-sm">
                    minutes per day
                </span>
                <Button
                    type="submit"
                    size="md"
                    variant="primary"
                    disabled={!canSave}
                    loading={update.isPending}>
                    Save
                </Button>
                {saved !== null && (
                    <Button
                        type="button"
                        size="md"
                        variant="cancel"
                        disabled={!canEdit || update.isPending}
                        onClick={() => send(null)}>
                        Remove limit
                    </Button>
                )}
            </form>
            {error && (
                <p id={ERROR_ID} role="alert" className="text-danger text-xs">
                    {error}
                </p>
            )}
            <p className="text-text-tertiary text-xs">
                Holds every setup, Run and environment session of the
                organization to this many machine minutes a day (UTC). Once they
                run out, Kodus refuses new setups and Runs with a blocker until
                the count resets at 00:00 UTC; machines already running finish.
                Your limit can only lower the deployment&apos;s; leave it unset
                to use the deployment&apos;s.
            </p>
            {!canEdit && (
                <p className="text-text-tertiary text-xs">
                    Only organization admins can change this limit.
                </p>
            )}
        </div>
    );
};
