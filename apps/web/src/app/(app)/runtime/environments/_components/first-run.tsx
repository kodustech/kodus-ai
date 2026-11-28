"use client";

import { useState, type ReactNode } from "react";
import NextLink from "next/link";
import { StatusChip } from "@components/runtime/status-chip";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Input } from "@components/ui/input";
import type {
    RuntimeEnvironment,
    RuntimeRepositorySettings,
} from "@services/runtime/contracts";
import { shortRepositoryName } from "@services/runtime/format";
import {
    environmentHref,
    environmentStatus,
} from "@services/runtime/model/environment";
import type {
    Onboarding,
    OnboardingStep,
} from "@services/runtime/model/onboarding";
import { modeOf } from "@services/runtime/model/rules";
import { CheckIcon, SearchIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import { AgentPromptHint } from "./agent-prompt-hint";
import { SetUpRepository } from "./new-environment";

type StepState = "done" | "current" | "upcoming";

const ORDER: OnboardingStep[] = ["pick", "watch", "test"];

const stepState = (step: OnboardingStep, at: OnboardingStep): StepState => {
    const i = ORDER.indexOf(step);
    const current = ORDER.indexOf(at);
    return i < current ? "done" : i === current ? "current" : "upcoming";
};

const linkClass = "text-primary-light text-sm font-medium hover:underline";

const nameOf = (env: Pick<RuntimeEnvironment, "repositoryName" | "repositoryId">) =>
    shortRepositoryName(env.repositoryName) ?? env.repositoryId;

const Step = ({
    n,
    title,
    state,
    children,
}: {
    n: number;
    title: string;
    state: StepState;
    children?: ReactNode;
}) => (
    <li
        aria-label={`Step ${n}: ${title}`}
        aria-current={state === "current" ? "step" : undefined}
        data-state={state}
        className="flex gap-4">
        <span
            aria-hidden
            className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                state === "done" && "bg-success/15 text-success",
                state === "current" && "bg-primary-light text-card-lv1",
                state === "upcoming" && "bg-card-lv2 text-text-tertiary",
            )}>
            {state === "done" ? <CheckIcon className="size-4" /> : n}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
            <Heading
                variant="h3"
                className={cn(
                    "text-sm",
                    state === "upcoming" && "text-text-tertiary",
                )}>
                {title}
                {state === "done" && <span className="sr-only"> (done)</span>}
            </Heading>
            {state !== "upcoming" && children}
        </div>
    </li>
);

const RepositoryPicker = ({
    repositories,
}: {
    repositories: ReadonlyArray<{ repositoryId: string; repositoryName?: string }>;
}) => {
    const [search, setSearch] = useState("");
    const term = search.trim().toLowerCase();
    const shown = [...repositories]
        .map((r) => ({ id: r.repositoryId, name: r.repositoryName ?? r.repositoryId }))
        .filter((r) => !term || r.name.toLowerCase().includes(term))
        .sort((a, b) => a.name.localeCompare(b.name));
    return (
        <div className="flex flex-col gap-2">
            {repositories.length > 6 && (
                <div className="w-full max-w-sm">
                    <Input
                        size="md"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search repositories..."
                        aria-label="Search repositories"
                        leftIcon={<SearchIcon />}
                    />
                </div>
            )}
            <ul
                aria-label="Connected repositories"
                className="bg-card-lv2 divide-card-lv3 flex max-h-80 flex-col divide-y overflow-y-auto rounded-lg">
                {shown.length === 0 && (
                    <li className="text-text-secondary px-4 py-3 text-sm">
                        No repository matches “{search.trim()}”.
                    </li>
                )}
                {shown.map((r) => (
                    <li
                        key={r.id}
                        className="flex items-center justify-between gap-3 px-4 py-2">
                        <span className="truncate text-sm font-medium" title={r.name}>
                            {shortRepositoryName(r.name) ?? r.name}
                        </span>
                        <SetUpRepository repositoryId={r.id} name={r.name} />
                    </li>
                ))}
            </ul>
        </div>
    );
};

/**
 * The first run of the Environments screen, in place of the table: pick a
 * repository, watch its first setup, test a pull request. The page decides
 * when it shows (model/onboarding.ts).
 */
export const FirstRun = <E extends RuntimeEnvironment>({
    onboarding,
    environments,
    repositories,
    canCreate,
}: {
    onboarding: Onboarding<E>;
    environments: readonly RuntimeEnvironment[];
    /** The connected repositories (Runtime settings), with their mode. */
    repositories: readonly RuntimeRepositorySettings[];
    canCreate: boolean;
}) => {
    const [another, setAnother] = useState(false);
    const { step, environment: env } = onboarding;
    const withEnv = new Set(environments.map((e) => e.repositoryId));
    const notSetUp = repositories.filter((r) => !withEnv.has(r.repositoryId));
    const pickerOpen = step === "pick" || another;
    const settings = env
        ? repositories.find((r) => r.repositoryId === env.repositoryId)
        : undefined;
    const status = env ? environmentStatus(env) : undefined;

    return (
        <section
            aria-label="Get started"
            className="bg-card-lv1 flex flex-col gap-5 rounded-xl p-6">
            <Heading variant="h2" className="text-base">
                Get started
            </Heading>
            <ol className="flex flex-col gap-6">
                <Step n={1} title="Pick a repository" state={stepState("pick", step)}>
                    {step !== "pick" && env && (
                        <p className="text-text-secondary text-sm">
                            {environments.length === 1
                                ? `Picked ${nameOf(env)}.`
                                : `Picked ${environments.length} repositories.`}
                        </p>
                    )}
                    {pickerOpen && (
                        <p className="text-text-secondary text-sm">
                            Kody reads the repository, works out how to build and
                            start it, and boots it on a clean machine; a few
                            minutes.
                        </p>
                    )}
                    {!canCreate ? (
                        pickerOpen && (
                            <p className="text-text-tertiary text-sm">
                                Someone who can edit repository settings sets it
                                up.
                            </p>
                        )
                    ) : pickerOpen ? (
                        <>
                            <RepositoryPicker repositories={notSetUp} />
                            <div className="mt-3">
                                <AgentPromptHint />
                            </div>
                        </>
                    ) : (
                        notSetUp.length > 0 && (
                            <Button
                                size="xs"
                                variant="helper"
                                className="self-start"
                                onClick={() => setAnother(true)}>
                                Set up another repository
                            </Button>
                        )
                    )}
                </Step>

                <Step
                    n={2}
                    title="Watch the first setup"
                    state={stepState("watch", step)}>
                    {env && status && step === "watch" && (
                        <div className="flex flex-col gap-2">
                            <span className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="font-medium">{nameOf(env)}</span>
                                <StatusChip tone={status.tone}>{status.label}</StatusChip>
                            </span>
                            <p className="text-text-secondary text-sm">
                                {onboarding.blocked
                                    ? "The setup stopped and needs you: open it to see why and how to fix it."
                                    : "Kody is booting it on a clean machine. Takes a few minutes; this page updates by itself."}
                            </p>
                            <NextLink
                                href={environmentHref(env.environmentId)}
                                className={cn(linkClass, "self-start")}>
                                {onboarding.blocked ? "Open the setup" : "Follow the setup"}
                            </NextLink>
                        </div>
                    )}
                    {env && step === "test" && (
                        <p className="text-text-secondary text-sm">
                            {nameOf(env)} is ready.
                        </p>
                    )}
                </Step>

                <Step
                    n={3}
                    title="Test a pull request"
                    state={stepState("test", step)}>
                    {env && (
                        <div className="flex flex-col gap-2">
                            <p className="text-text-secondary text-sm">
                                Comment{" "}
                                <code className="bg-card-lv2 rounded px-1 font-mono text-xs">
                                    @kody runtime
                                </code>{" "}
                                on a pull request of {nameOf(env)}. Kody runs the
                                pull request and its base, and posts what changed.
                            </p>
                            {modeOf(settings) === "off" && (
                                <p className="text-warning text-sm">
                                    Runtime is Off for {nameOf(env)}: set it to On
                                    request first.{" "}
                                    <NextLink href="/runtime/settings" className={linkClass}>
                                        Open Runtime settings
                                    </NextLink>
                                </p>
                            )}
                        </div>
                    )}
                </Step>
            </ol>
        </section>
    );
};
