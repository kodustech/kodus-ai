"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@components/ui/button";
import { Label } from "@components/ui/label";
import { RadioGroup } from "@components/ui/radio-group";
import { toast } from "@components/ui/toaster/use-toast";
import type {
    MachineSizePreset,
    MachineSize as Size,
} from "@services/runtime/contracts";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    formatMachineSize,
    MACHINE_SIZE_OPTIONS,
    machineSizeAwaitsSetup,
    machineSizeChoiceLabel,
    machineSizeOption,
    type MachineSizeChoice as Choice,
} from "@services/runtime/model/machine-size";
import { useUpdateEnvironmentSettings } from "@services/runtime/queries";

// The environment's Machine size setting: what its setups boot at now, the
// presets to choose from (services/runtime/model/machine-size.ts) and the
// ceiling a cell in the org's own cloud sets.

/** What the setups boot at now, and whether the saved size waits for the next one. */
const SizeInUse = ({
    saved,
    bootedAt,
    hasSetup,
    pending,
    setupAction,
}: {
    saved: Choice;
    bootedAt?: Size;
    hasSetup: boolean;
    pending: boolean;
    setupAction?: ReactNode;
}) => (
    <div className="flex flex-col gap-2">
        <p className="text-sm" aria-live="polite">
            {!hasSetup ? (
                <>
                    The first setup boots at{" "}
                    <strong>{machineSizeChoiceLabel(saved)}</strong>.
                </>
            ) : pending ? (
                <>
                    The last setup booted at{" "}
                    <strong>
                        {bootedAt
                            ? formatMachineSize(bootedAt)
                            : "the host default"}
                    </strong>
                    . The next one boots at{" "}
                    <strong>{machineSizeChoiceLabel(saved)}</strong>.
                </>
            ) : (
                <>
                    Setups boot at{" "}
                    <strong>{machineSizeChoiceLabel(saved)}</strong>.
                </>
            )}
        </p>
        {pending && (
            <div className="flex flex-wrap items-center gap-3">
                <p className="text-warning text-sm">
                    Set it up again to boot at the saved size.
                </p>
                {setupAction}
            </div>
        )}
    </div>
);

export const MachineSizeSetting = ({
    environmentId,
    setting,
    bootedAt,
    hasSetup,
    canEdit,
    selfHosted = false,
    setupAction,
}: {
    environmentId: string;
    /** The saved preset; null or absent: the cell's default. */
    setting?: MachineSizePreset | null;
    /** The size the last setup booted at; absent: the cell's default. */
    bootedAt?: Size;
    /** A setup ran at least once, so a saved change waits for the next one. */
    hasSetup: boolean;
    canEdit: boolean;
    /** The environment runs on a cell in the org's own cloud, which sets its own ceiling. */
    selfHosted?: boolean;
    /** Sets the environment up again, shown when the saved size is not the one it booted at. */
    setupAction?: ReactNode;
}) => {
    // Remounted with a new `key` when the saved value changes.
    const saved: Choice = setting ?? "default";
    const [choice, setChoice] = useState<Choice>(saved);
    const update = useUpdateEnvironmentSettings();
    const dirty = choice !== saved;
    const pending = hasSetup && machineSizeAwaitsSetup(saved, bootedAt);

    const save = () =>
        update.mutate(
            {
                environmentId,
                machineSize: choice === "default" ? null : choice,
            },
            {
                onSuccess: () =>
                    toast({
                        variant: "success",
                        title: "Machine size saved",
                        description: hasSetup
                            ? "It applies from the next setup."
                            : undefined,
                    }),
                onError: (error) =>
                    toast({
                        variant: "danger",
                        title: "Couldn't save the machine size",
                        description: runtimeErrorMessage(error, {
                            fallback: "Try again in a moment.",
                            403: "Only the owner of the organization can change it.",
                        }),
                    }),
            },
        );

    return (
        <div className="flex flex-col gap-4">
            <SizeInUse
                saved={saved}
                bootedAt={bootedAt}
                hasSetup={hasSetup}
                pending={pending}
                setupAction={setupAction}
            />

            <form
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (dirty) save();
                }}>
                <RadioGroup.Root
                    aria-label="Machine size"
                    value={choice}
                    onValueChange={(value) => {
                        const o = machineSizeOption(value);
                        if (o) setChoice(o.value);
                    }}
                    disabled={!canEdit || update.isPending}
                    className="gap-2">
                    {MACHINE_SIZE_OPTIONS.map((o) => (
                        <Label
                            key={o.value}
                            className="flex cursor-pointer items-start gap-3 text-sm leading-snug">
                            <RadioGroup.Item
                                value={o.value}
                                className="mt-0.5"
                            />
                            <span className="flex flex-col gap-0.5">
                                <span className="text-text-primary">
                                    {o.label}
                                    {o.size && (
                                        <span className="text-text-secondary font-normal">
                                            {" "}
                                            · {formatMachineSize(o.size)}
                                        </span>
                                    )}
                                </span>
                                <span className="text-text-secondary text-xs font-normal">
                                    {o.hint}
                                </span>
                            </span>
                        </Label>
                    ))}
                </RadioGroup.Root>
                <div>
                    <Button
                        type="submit"
                        size="md"
                        variant="primary"
                        disabled={!canEdit || !dirty}
                        loading={update.isPending}>
                        Save
                    </Button>
                </div>
            </form>

            <p className="text-text-tertiary text-xs">
                A build that runs out of memory is stopped: heavy compiled
                builds need Medium or Large. Each Run boots at the size of its
                setup.
                {selfHosted && (
                    <>
                        {" "}
                        A host in your cloud grants at most its{" "}
                        <code className="font-mono">
                            -gvisor-mem-max
                        </code> and{" "}
                        <code className="font-mono">-gvisor-cpus-max</code>; a
                        larger size is refused before anything boots.
                    </>
                )}
                {!canEdit &&
                    " Only the owner of the organization can change it."}
            </p>
        </div>
    );
};
