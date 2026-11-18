"use client";

import { useEffect, useId, useState, type ComponentProps } from "react";
import { StuckNotice } from "@components/runtime/stuck-notice";
import { Button } from "@components/ui/button";
import { toast } from "@components/ui/toaster/use-toast";
import { usePermissionOnEvery } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type {
    RuntimeEnvironment,
    SetupFailureBundle,
} from "@services/runtime/contracts";
import {
    formatDurationMs,
    formatGiB,
    shortSha,
} from "@services/runtime/format";
import {
    blockerKindLabel,
    setupStepStateLabel,
    setupStepStateTone,
} from "@services/runtime/labels";
import { setupBootPhases } from "@services/runtime/model/boot-phases";
import {
    environmentSetupMs,
    buildCacheEvictedWords,
    environmentStatus,
    isEnvironmentBusy,
    isRunOnlyEnvironment,
    lastBootStepIndex,
    plainBootFailure,
    setupActionLabel,
    setupRepairNotes,
    setupStepTitle,
} from "@services/runtime/model/environment";
import { repositoryIdsOfEnvironment } from "@services/runtime/model/environment-repositories";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import { machineMinutesBlockerWords } from "@services/runtime/model/machine-minutes";
import { useRequestEnvironmentSetup } from "@services/runtime/queries";
import { RotateCcwIcon } from "lucide-react";

import { BootPhases } from "./boot-phases";
import { BootProgress, useElapsed } from "./boot-progress";
import { RelativeTime } from "./relative-time";
import { StatusChip } from "./status-chip";

/**
 * POST /runtime/environments/:id/setup — set the environment up (again) from
 * the setup file on the default branch. Shown only to who can edit the repository,
 * and never for an environment known only from earlier Runs (the route 404s).
 */
export const SetupEnvironmentButton = ({
    env,
    size = "sm",
    variant = "secondary",
    iconOnly = false,
    name,
}: {
    env: Pick<
        RuntimeEnvironment,
        "environmentId" | "repositoryId" | "state" | "setup"
    > &
        Partial<Pick<RuntimeEnvironment, "repositories" | "managed">>;
    size?: ComponentProps<typeof Button>["size"];
    variant?: ComponentProps<typeof Button>["variant"];
    /** A list row: the icon alone, named after the environment (`name`). */
    iconOnly?: boolean;
    name?: string;
}) => {
    const setup = useRequestEnvironmentSetup();
    // The API checks every repository the setup boots.
    const canEdit = usePermissionOnEvery(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryIdsOfEnvironment(env),
    );
    if (!canEdit || isRunOnlyEnvironment(env)) return null;
    const busy = isEnvironmentBusy(env);
    const label = setupActionLabel(env);
    const named = name ? `${label.replace(/…$/, "")} ${name}` : label;
    return (
        <Button
            size={iconOnly ? "icon-sm" : size}
            variant={iconOnly ? "helper" : variant}
            leftIcon={iconOnly ? undefined : <RotateCcwIcon />}
            aria-label={iconOnly ? named : undefined}
            title={iconOnly ? named : undefined}
            loading={setup.isPending}
            disabled={busy || setup.isPending}
            onClick={() =>
                setup.mutate(env.environmentId, {
                    onError: (error) =>
                        toast({
                            variant: "danger",
                            title: "Couldn't request the setup",
                            description: runtimeErrorMessage(error, {
                                fallback: "Try again in a moment.",
                            }),
                        }),
                })
            }>
            {iconOnly ? <RotateCcwIcon /> : label}
        </Button>
    );
};

/** What the cell saw when the setup failed: services, logs, ports, disk, denied egress. */
const FailureBundle = ({ bundle }: { bundle: SetupFailureBundle }) => (
    <details className="bg-card-lv2 rounded-lg p-3 text-sm">
        <summary className="focus-visible:ring-ring cursor-pointer rounded-md font-medium focus-visible:ring-3 focus-visible:outline-none">
            Failure bundle
            <span className="text-text-tertiary ml-2 text-xs">
                {bundle.redactions} redacted
                {bundle.truncated ? " · truncated" : ""}
            </span>
        </summary>
        <div className="mt-3 flex flex-col gap-3">
            {bundle.ports.length > 0 && (
                <p className="text-text-secondary text-xs">
                    Ports:{" "}
                    {bundle.ports
                        .map(
                            (p) =>
                                `${p.service}:${p.port} ${p.listening ? "listening" : "not listening"}`,
                        )
                        .join(" · ")}
                </p>
            )}
            {bundle.disk.map((d) => (
                <p key={d.path} className="text-text-secondary text-xs">
                    Disk {d.path}: {formatGiB(d.freeBytes)} free of{" "}
                    {formatGiB(d.totalBytes)}
                </p>
            ))}
            {bundle.deniedEgress.length > 0 && (
                <p className="text-text-secondary text-xs">
                    Denied egress:{" "}
                    {bundle.deniedEgress
                        .map((e) => `${e.host}:${e.port}`)
                        .join(" · ")}
                </p>
            )}
            {bundle.services.map((s) => (
                <div key={s.name} className="flex flex-col gap-1">
                    <span className="text-xs">
                        <span className="font-medium">{s.name}</span>{" "}
                        <span className="text-text-tertiary">{s.state}</span>
                    </span>
                    {s.logTail.length > 0 && (
                        <pre className="bg-card-lv1 max-h-64 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap">
                            {s.logTail.join("\n")}
                        </pre>
                    )}
                </div>
            ))}
        </div>
    </details>
);

/**
 * The latest setup the runtime-worker recorded (it keeps one per
 * environment): its status, each step, its blockers and, when it failed, what
 * the cell collected. `detailed` opens the steps and shows the failure bundle.
 */
export const EnvironmentSetupCard = ({
    env,
    detailed = false,
}: {
    env: RuntimeEnvironment;
    detailed?: boolean;
}) => {
    const busy = isEnvironmentBusy(env);
    const [open, setOpen] = useState(detailed || busy);
    // A setup that starts while the page is open shows its steps on its own.
    useEffect(() => {
        if (busy) setOpen(true);
    }, [busy]);
    const stepsId = useId();
    const setup = env.setup;
    const status = environmentStatus(env);
    // The cell removed the build cache since this setup: its PRs build cold until a setup again.
    const cacheEvicted = buildCacheEvictedWords(env);
    const runningStep = setup?.steps.find((s) => s.state === "running");
    const runningMs = useElapsed(runningStep?.startedAt, busy && !!runningStep);
    const repairs = setupRepairNotes(setup);
    // The cell's progress is the last boot's: a boot Kody's repair replaced keeps none.
    const progressStep = setup ? lastBootStepIndex(setup.steps) : -1;
    const bootPhases = setupBootPhases(setup);
    const bootLive = busy && setup?.steps[progressStep]?.state === "running";

    if (!setup) {
        return (
            <p className="text-text-secondary text-sm">
                {isEnvironmentBusy(env)
                    ? "Waiting for the Runtime to pick up the request…"
                    : "No setup recorded yet."}
            </p>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <StuckNotice what="setup" stuck={setup.stuck} />
            {cacheEvicted && (
                <p role="status" className="text-warning text-sm">
                    {cacheEvicted}
                </p>
            )}
            <div className="flex flex-wrap items-center gap-3 text-sm">
                <StatusChip tone={status.tone}>{status.label}</StatusChip>
                <span className="font-mono">{shortSha(setup.sha)}</span>
                <span className="text-text-secondary">
                    {setup.branch ?? "default branch"}
                    {setup.refSource === "dev_override"
                        ? " · dev override"
                        : ""}
                </span>
                {setup.cellId && (
                    <span className="text-text-tertiary text-xs">
                        on <span className="font-mono">{setup.cellId}</span>
                    </span>
                )}
                <span className="text-text-tertiary ml-auto text-xs">
                    <RelativeTime at={setup.requestedAt} /> ·{" "}
                    {formatDurationMs(environmentSetupMs(env))}
                </span>
                <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={stepsId}
                    onClick={() => setOpen((v) => !v)}
                    className="text-text-secondary hover:text-primary-light focus-visible:ring-ring rounded-md text-xs transition-colors hover:underline focus-visible:ring-3 focus-visible:outline-none">
                    {open ? "Hide steps" : "Show steps"}
                </button>
            </div>

            <BootPhases phases={bootPhases} live={bootLive} />

            {repairs.length > 0 && (
                <ul
                    className="flex flex-col gap-1 text-sm"
                    aria-label="Kody's setup file repairs">
                    {repairs.map((r) => (
                        <li key={r.key} className="flex flex-col">
                            <span className="text-text-primary">{r.text}</span>
                            <span className="text-text-tertiary text-xs">
                                What failed: {r.blocker}
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            {open && (
                <ol
                    id={stepsId}
                    className="flex flex-col gap-1.5"
                    aria-label="Setup steps">
                    {setup.steps.length === 0 && (
                        <li className="text-text-secondary text-xs">
                            No step recorded yet.
                        </li>
                    )}
                    {setup.steps.map((step, i) => (
                        <li
                            key={`${step.name}-${i}`}
                            className="flex flex-wrap items-center gap-3 text-xs">
                            <StatusChip tone={setupStepStateTone(step.state)}>
                                {setupStepStateLabel(step.state)}
                            </StatusChip>
                            <span className="text-text-primary w-36">
                                {setupStepTitle(step)}
                            </span>
                            <span className="text-text-tertiary font-mono">
                                {step.state === "running" && busy
                                    ? formatDurationMs(runningMs)
                                    : formatDurationMs(step.durationMs)}
                            </span>
                            {step.detail && (
                                <span className="text-text-secondary">
                                    {step.detail}
                                </span>
                            )}
                            {i === progressStep && setup.progress && (
                                <div className="basis-full">
                                    <BootProgress
                                        progress={setup.progress}
                                        live={busy && step.state === "running"}
                                        last={setup.lastActive}
                                    />
                                </div>
                            )}
                        </li>
                    ))}
                </ol>
            )}

            {setup.blockers.length > 0 && (
                <ul className="flex flex-col gap-2" aria-label="Setup blockers">
                    {setup.blockers.map((b) => (
                        <li
                            key={b.signature}
                            className="bg-card-lv2 rounded-lg p-3 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                                <StatusChip tone="danger">
                                    {blockerKindLabel(b.kind)}
                                </StatusChip>
                                <span className="text-text-tertiary font-mono text-xs">
                                    {b.signature}
                                </span>
                            </div>
                            {machineMinutesBlockerWords(b) ? (
                                <p className="text-text-primary mt-1">
                                    {machineMinutesBlockerWords(b)}
                                </p>
                            ) : plainBootFailure(b.message) !== b.message ? (
                                <>
                                    <p className="text-text-primary mt-1">
                                        {plainBootFailure(b.message)}
                                    </p>
                                    <details className="mt-1">
                                        <summary className="text-text-tertiary cursor-pointer text-xs">
                                            Build output
                                        </summary>
                                        <pre className="bg-card-lv1 text-text-secondary text-2xs mt-1 max-h-48 overflow-auto rounded-md p-2 font-mono leading-relaxed whitespace-pre-wrap">
                                            {b.message}
                                        </pre>
                                    </details>
                                </>
                            ) : (
                                <p className="text-text-secondary mt-1">
                                    {b.message}
                                </p>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {detailed && setup.diagnosticHold && (
                <p className="text-text-secondary text-sm">
                    Machines kept for diagnosis on{" "}
                    <span className="font-mono">
                        {setup.diagnosticHold.cellId}
                    </span>
                    ; they are destroyed{" "}
                    <RelativeTime at={setup.diagnosticHold.until} />. No check
                    runs on them.
                </p>
            )}
            {detailed && setup.failureBundle && (
                <FailureBundle bundle={setup.failureBundle} />
            )}
        </div>
    );
};
