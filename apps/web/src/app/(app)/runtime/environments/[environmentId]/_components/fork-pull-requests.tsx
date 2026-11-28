"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Label } from "@components/ui/label";
import { RadioGroup } from "@components/ui/radio-group";
import { toast } from "@components/ui/toaster/use-toast";
import type { ForkPullRequestPolicy } from "@services/runtime/contracts";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    FORK_POLICY_OPTIONS,
    forkPolicyOption,
    heldForkPolicyNote,
} from "@services/runtime/model/fork-pull-requests";
import { useUpdateEnvironmentSettings } from "@services/runtime/queries";

// The environment's policy for pull requests from forks
// (services/runtime/model/fork-pull-requests.ts).

export const ForkPullRequestsSetting = ({
    environmentId,
    setting,
    effective,
    canEdit,
}: {
    environmentId: string;
    setting: ForkPullRequestPolicy;
    /** The policy that applies (the API's effectiveForkPullRequests). */
    effective?: ForkPullRequestPolicy;
    canEdit: boolean;
}) => {
    const held = heldForkPolicyNote(setting, effective);
    // Remounted with a new `key` when the saved value changes.
    const [choice, setChoice] = useState<ForkPullRequestPolicy>(setting);
    const update = useUpdateEnvironmentSettings();
    const dirty = choice !== setting;

    const save = () =>
        update.mutate(
            { environmentId, forkPullRequests: choice },
            {
                onSuccess: () =>
                    toast({
                        variant: "success",
                        title: "Fork policy saved",
                        description: "It applies to the next pull request event.",
                    }),
                onError: (error) =>
                    toast({
                        variant: "danger",
                        title: "Couldn't save the fork policy",
                        description: runtimeErrorMessage(error, {
                            fallback: "Try again in a moment.",
                            403: "Only the owner of the organization can change it.",
                        }),
                    }),
            },
        );

    return (
        <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
                event.preventDefault();
                if (dirty) save();
            }}>
            {held && <p className="text-warning text-sm">{held}</p>}
            <RadioGroup.Root
                aria-label="Pull requests from forks"
                value={choice}
                onValueChange={(value) => {
                    const o = forkPolicyOption(value);
                    if (o) setChoice(o.value);
                }}
                disabled={!canEdit || update.isPending}
                className="gap-2">
                {FORK_POLICY_OPTIONS.map((o) => (
                    <Label
                        key={o.value}
                        className="flex cursor-pointer items-start gap-3 text-sm leading-snug">
                        <RadioGroup.Item value={o.value} className="mt-0.5" />
                        <span className="flex flex-col gap-0.5">
                            <span className="text-text-primary">{o.label}</span>
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
            <p className="text-text-tertiary text-xs">
                A Run on a fork gets a quarter of the LLM budget and never
                uses a machine kept ready.
                {!canEdit &&
                    " Only the owner of the organization can change it."}
            </p>
        </form>
    );
};
