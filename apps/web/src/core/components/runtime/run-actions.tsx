"use client";

import type { ComponentProps } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { toast } from "@components/ui/toaster/use-toast";
import { usePermissionOnEvery } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { RuntimeRun } from "@services/runtime/contracts";
import { canApprove, canRunAgain } from "@services/runtime/labels";
import { repositoryIdsOfRun } from "@services/runtime/model/environment-repositories";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import { useApproveRun, useRerunRun } from "@services/runtime/queries";
import { RotateCcwIcon, ShieldCheckIcon } from "lucide-react";

type ButtonLook = Partial<
    Pick<ComponentProps<typeof Button>, "size" | "variant">
>;
/** The repositories the Run booted with (`workspace`): the API checks the caller on each. */
type RunRef = Pick<RuntimeRun, "runId" | "repositoryId" | "state"> &
    Partial<Pick<RuntimeRun, "workspace">>;

/** "Run again": a new attempt of a finished Run, then opens it. */
export const RerunButton = ({
    run,
    size = "md",
    variant = "primary",
}: { run: RunRef } & ButtonLook) => {
    const router = useRouter();
    const rerun = useRerunRun();
    const allowed = usePermissionOnEvery(
        Action.Create,
        ResourceType.RuntimeRun,
        repositoryIdsOfRun(run),
    );
    if (!allowed || !canRunAgain(run.state)) return null;
    return (
        <Button
            size={size}
            variant={variant}
            leftIcon={<RotateCcwIcon />}
            loading={rerun.isPending}
            onClick={() =>
                rerun.mutate(run.runId, {
                    onSuccess: (next) => {
                        toast({ variant: "success", title: "New run queued" });
                        if (next?.runId && next.runId !== run.runId)
                            router.push(
                                `/runtime/runs/${encodeURIComponent(next.runId)}`,
                            );
                    },
                    onError: (error) =>
                        toast({
                            variant: "danger",
                            title: "Couldn't start a new run",
                            description: runtimeErrorMessage(error, {
                                fallback: "Try again in a moment.",
                                403: "Only people allowed to ask @kody runtime on this repository can run it again.",
                            }),
                        }),
                })
            }>
            Run again
        </Button>
    );
};

/**
 * Approves a fork Run waiting for a maintainer. The API needs Create on
 * RuntimeRun for the repository (as Run again), then asks the Git provider
 * (write access, not the PR author); its reason is shown when it refuses.
 */
export const ApproveRunButton = ({
    run,
    size = "md",
    variant = "primary",
}: { run: RunRef } & ButtonLook) => {
    const approve = useApproveRun();
    const allowed = usePermissionOnEvery(
        Action.Create,
        ResourceType.RuntimeRun,
        repositoryIdsOfRun(run),
    );
    if (!allowed || !canApprove(run.state)) return null;
    return (
        <Button
            size={size}
            variant={variant}
            leftIcon={<ShieldCheckIcon />}
            loading={approve.isPending}
            onClick={() =>
                approve.mutate(run.runId, {
                    onSuccess: () =>
                        toast({
                            variant: "success",
                            title: "Run approved",
                            description:
                                "It starts on the current head of the pull request.",
                        }),
                    onError: (error) =>
                        toast({
                            variant: "danger",
                            title: "Couldn't approve this run",
                            description: runtimeErrorMessage(error, {
                                fallback: "Try again in a moment.",
                            }),
                        }),
                })
            }>
            Approve this run
        </Button>
    );
};
