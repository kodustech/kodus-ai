"use client";

import { Button } from "@components/ui/button";
import { toast } from "@components/ui/toaster/use-toast";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import { useCreateRuntimeEnvironment } from "@services/runtime/queries";
import { SparklesIcon } from "lucide-react";

export { agentPrompt } from "@services/runtime/model/agent-prompt";

/**
 * A repository row's "Set up", with its own mutation: a shared one tracks only
 * its latest call, so a quick second click dropped the first row's answer and
 * held every other row. Each row waits on its own request; once the
 * environments list refreshes, the row becomes the environment's row.
 */
export const SetUpRepository = ({
    repositoryId,
    name,
    onStarted,
    iconOnly = false,
}: {
    repositoryId: string;
    name: string;
    onStarted?: (environmentId: string) => void;
    /** A list row: an icon with the repository in its name, not an amber button per row. */
    iconOnly?: boolean;
}) => {
    const create = useCreateRuntimeEnvironment();
    return (
        <Button
            size={iconOnly ? "icon-sm" : "sm"}
            variant={iconOnly ? "helper" : "primary"}
            leftIcon={iconOnly ? undefined : <SparklesIcon />}
            loading={create.isPending || create.isSuccess}
            aria-label={`Set up ${name}`}
            title={iconOnly ? `Set up ${name}` : undefined}
            onClick={() =>
                create.mutate(repositoryId, {
                    onSuccess: (data) => onStarted?.(data.environmentId),
                    onError: (error) =>
                        toast({
                            variant: "danger",
                            title: `Couldn't set up ${name}`,
                            description: runtimeErrorMessage(error, {
                                fallback: "Try again in a moment.",
                            }),
                        }),
                })
            }>
            {iconOnly ? <SparklesIcon /> : "Set up"}
        </Button>
    );
};
