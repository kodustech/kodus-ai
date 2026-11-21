"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import { toast } from "@components/ui/toaster/use-toast";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    hostPriceDraft,
    hostPriceWords,
    MAX_USD_PER_HOST_HOUR,
} from "@services/runtime/model/machine-host-price";
import { useUpdateRuntimeOrgSettings } from "@services/runtime/queries";

const ERROR_ID = "org-host-price-error";

/**
 * The org's price per host-hour: whether its own hosts are priced, and an
 * admin's field to set the price or remove it. Remount with a `key` of the
 * saved `value` so the field follows what was saved.
 */
export const MachineHostPrice = ({
    value,
    canEdit,
}: {
    value: number | null;
    canEdit: boolean;
}) => {
    const [draft, setDraft] = useState(value !== null ? String(value) : "");
    const update = useUpdateRuntimeOrgSettings();
    const { usdPerHour, error } = hostPriceDraft(draft);
    const canSave =
        canEdit && !error && usdPerHour !== null && usdPerHour !== value;

    const send = (next: number | null) =>
        update.mutate(
            { machineUsdPerHostHour: next },
            {
                onSuccess: () => {
                    if (next === null) setDraft("");
                    toast({
                        variant: "success",
                        title: next === null ? "Price removed" : "Price saved",
                        description:
                            next === null
                                ? "Machine time on your own hosts is not priced."
                                : "Costs on your own hosts use it, past Runs included.",
                    });
                },
                onError: (e) =>
                    toast({
                        variant: "danger",
                        title: "Couldn't save the price",
                        description: runtimeErrorMessage(e, {
                            fallback: "Try again in a moment.",
                        }),
                    }),
            },
        );

    return (
        <div className="flex flex-col gap-2">
            <p className="text-text-primary text-sm">
                {hostPriceWords(value)}
            </p>
            <form
                className="flex flex-wrap items-center gap-3"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (canSave) send(usdPerHour);
                }}>
                {/* Input's wrapper grows (flex-1): a fixed-width box keeps the field short. */}
                <div className="w-56">
                    <Input
                        type="number"
                        min={0}
                        max={MAX_USD_PER_HOST_HOUR}
                        step="any"
                        inputMode="decimal"
                        aria-label="Price per host-hour, in US$"
                        aria-invalid={!!error}
                        aria-describedby={error ? ERROR_ID : undefined}
                        placeholder="Not set"
                        value={draft}
                        disabled={!canEdit}
                        onChange={(event) => setDraft(event.target.value)}
                    />
                </div>
                <span className="text-text-tertiary text-sm">
                    US$ per host-hour
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
                        Remove the price
                    </Button>
                )}
            </form>
            {error && (
                <p id={ERROR_ID} role="alert" className="text-danger text-xs">
                    {error}
                </p>
            )}
            <p className="text-text-tertiary text-xs">
                What one hour of one of your hosts costs you. Kody prices a
                Run&apos;s machine time by the share of the host its machines
                held, and shows it on the Run, in Health and in Usage. Machines
                on Kodus hosts keep their own price. A host that starts one
                machine per Run (aws-ec2) stays unpriced.
            </p>
            {!canEdit && (
                <p className="text-text-tertiary text-xs">
                    Only organization admins can change this.
                </p>
            )}
        </div>
    );
};
