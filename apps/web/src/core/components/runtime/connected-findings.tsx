"use client";

import { toast } from "@components/ui/toaster/use-toast";
import { usePermissionOnEvery } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { RuntimeRun } from "@services/runtime/contracts";
import { baseVersionLabel } from "@services/runtime/model/base-version";
import type { BootFailureView } from "@services/runtime/model/boot-failure";
import { repositoryIdsOfRun } from "@services/runtime/model/environment-repositories";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import type { Finding } from "@services/runtime/model/findings";
import type { RunPaths } from "@services/runtime/model/run-paths";
import {
    useFindingFeedback,
    useFindingIntent,
} from "@services/runtime/queries";

import { RunFindingsView } from "./run-findings";

/**
 * The finding cards of a Run with their votes and "Mark as intended" wired:
 * one component for the Run page and the PR's Runtime tab.
 */
export const ConnectedFindings = ({
    run,
    findings,
    runPaths,
    live,
    pullRequestUrl,
    bootFailure,
    patchOf,
}: {
    run: RuntimeRun;
    findings: Finding[];
    runPaths: RunPaths;
    live: boolean;
    pullRequestUrl?: string;
    bootFailure?: BootFailureView;
    patchOf?: (file: string) => string | undefined;
}) => {
    const vote = useFindingFeedback();
    const intent = useFindingIntent();
    // Marking a finding intended is gated like "Run again": write on Runs of this repository.
    const canMarkIntended = usePermissionOnEvery(
        Action.Create,
        ResourceType.RuntimeRun,
        repositoryIdsOfRun(run),
    );
    const failed = (title: string) => (error: unknown) =>
        toast({
            variant: "danger",
            title,
            description: runtimeErrorMessage(error, {
                fallback: "Try again in a moment.",
            }),
        });
    return (
        <RunFindingsView
            runId={run.runId}
            findings={findings}
            baseLabel={baseVersionLabel(run)}
            pullRequestUrl={pullRequestUrl}
            bootFailure={bootFailure}
            patchOf={patchOf}
            live={live}
            compared={runPaths.testedCount > 0}
            newEndpoints={
                runPaths.paths.filter((p) => p.outcome === "new_endpoint")
                    .length
            }
            missing={run.state === "regression" && findings.length === 0}
            feedback={run.feedback}
            votePendingFor={
                vote.isPending ? vote.variables?.probeId : undefined
            }
            intentPendingFor={
                intent.isPending ? intent.variables?.probeId : undefined
            }
            onMarkIntended={
                canMarkIntended
                    ? (probeId, intended) =>
                          intent.mutate(
                              { runId: run.runId, probeId, intended },
                              { onError: failed("Couldn't save the mark") },
                          )
                    : undefined
            }
            onVote={(probeId, value) =>
                vote.mutate(
                    { runId: run.runId, probeId, value },
                    { onError: failed("Couldn't save your feedback") },
                )
            }
        />
    );
};
