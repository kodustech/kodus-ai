"use client";

import { followSection } from "@components/runtime/disclosure";
import { SetupEnvironmentButton } from "@components/runtime/environment-setup";
import { RelativeTime } from "@components/runtime/relative-time";
import { StatusChip } from "@components/runtime/status-chip";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import type { RuntimeEnvironment } from "@services/runtime/contracts";
import { formatDurationMs } from "@services/runtime/format";
import { cellOwnerLabel } from "@services/runtime/labels";
import {
    activeSetupMs,
    currentSetup,
    currentSetupCommit,
    environmentNextStep,
} from "@services/runtime/model/environment";
import { ArrowRightIcon } from "lucide-react";

/** What Runs boot from today, in one line; only the facts that exist. */
const CurrentSetupLine = ({ env }: { env: RuntimeEnvironment }) => {
    const current = currentSetup(env);
    const commit = currentSetupCommit(env);
    const took = activeSetupMs(env);
    return (
        <p className="text-text-tertiary text-xs">
            {current ? (
                <>
                    {`Runs boot from ${current.branch ?? "the default branch"}`}
                    {commit && (
                        <>
                            {" at "}
                            <code className="font-mono">{commit}</code>
                        </>
                    )}
                    , set up <RelativeTime at={current.finishedAt} />
                    {took !== undefined && ` in ${formatDurationMs(took)}`}{" "}
                    ·{" "}
                </>
            ) : null}
            Machines on {cellOwnerLabel(env.cellOwner)}
        </p>
    );
};

/**
 * The top of the environment page: the state in plain words and the one
 * thing to do next. Everything below it is detail for that step.
 */
export const EnvironmentNextStep = ({
    env,
    canSetUp,
    environments,
}: {
    env: RuntimeEnvironment;
    /** The viewer can request a setup (SetupEnvironmentButton checks it too). */
    canSetUp: boolean;
    /** The org's environments: one known only from earlier Runs links its repository's managed one. */
    environments?: readonly RuntimeEnvironment[];
}) => {
    const step = environmentNextStep(env, environments);
    const action = step.action;
    return (
        <section
            aria-label="Next step"
            className="bg-card-lv1 flex flex-wrap items-center justify-between gap-4 rounded-xl p-6">
            <div className="flex max-w-2xl min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                    <StatusChip tone={step.tone}>{step.title}</StatusChip>
                </div>
                <p className="text-text-primary text-sm">{step.detail}</p>
                <CurrentSetupLine env={env} />
            </div>
            {action?.kind === "setup" &&
                (canSetUp ? (
                    <SetupEnvironmentButton
                        env={env}
                        size="md"
                        variant="primary"
                    />
                ) : (
                    <p className="text-text-secondary max-w-56 text-xs">
                        Someone who can edit this repository&apos;s settings
                        sets it up.
                    </p>
                ))}
            {action?.kind === "link" && (
                <Link
                    href={action.href}
                    noHoverUnderline
                    // A section of this page may be folded or already on screen: open it and show what runs in it now.
                    onClick={
                        action.href.startsWith("#")
                            ? () => followSection(action.href.slice(1))
                            : undefined
                    }>
                    <Button
                        size="md"
                        variant="primary"
                        rightIcon={<ArrowRightIcon />}
                        decorative>
                        {action.label}
                    </Button>
                </Link>
            )}
        </section>
    );
};
