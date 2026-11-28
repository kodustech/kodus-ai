"use client";

import { useEffect, useMemo } from "react";
import NextLink from "next/link";
import { BlockerCard } from "@components/runtime/blocker-card";
import { flash, RuntimeDisclosure } from "@components/runtime/disclosure";
import { EgressApprovalsList } from "@components/runtime/egress-access";
import {
    RuntimeEmptyState,
    RuntimeErrorState,
} from "@components/runtime/empty-state";
import {
    EnvironmentSetupCard,
    SetupEnvironmentButton,
} from "@components/runtime/environment-setup";
import {
    InferredRecipe,
    RepositoryRecipe,
} from "@components/runtime/inferred-recipe";
import { KodyAttempts } from "@components/runtime/kody-attempts";
import { RuntimeSection, RuntimeSubsection } from "@components/runtime/section";
import { SimulateOnPastPrs } from "@components/runtime/simulate-on-past-prs";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";
import {
    usePermission,
    usePermissionOnEvery,
} from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { shortRepositoryName } from "@services/runtime/format";
import {
    blockerAnchorId,
    groupBlockersBySignature,
    MACHINE_SIZE_SECTION_ID,
    splitBlockersByFrequency,
} from "@services/runtime/model/blockers";
import {
    ENVIRONMENT_SECTION,
    environmentNextStep,
    isEnvironmentBusy,
    isRunOnlyEnvironment,
} from "@services/runtime/model/environment";
import {
    environmentRepositoriesOf,
    namesInWords,
    repositoryIdsOfEnvironment,
    repositoryLabel,
} from "@services/runtime/model/environment-repositories";
import {
    settingsTakeaway,
    setupTakeaway,
} from "@services/runtime/model/environment-sections";
import {
    useEnvironmentBlockers,
    useEnvironmentLessons,
    useRuntimeEnvironment,
    useRuntimeEnvironments,
    useRuntimeSettings,
} from "@services/runtime/queries";
import { decodeRouteParam } from "@services/runtime/route-params";
import { ActivityIcon, ArrowLeftIcon } from "lucide-react";

import { EnvironmentSuiteSection } from "./_components/e2e-suite";
import { ApproveHostForm } from "./_components/egress-approval";
import { EnvironmentPreviewSection } from "./_components/environment-preview";
import { ForkPullRequestsSetting } from "./_components/fork-pull-requests";
import { EnvironmentLessons } from "./_components/lessons";
import { MachineSizeSetting } from "./_components/machine-size";
import { EnvironmentNextStep } from "./_components/next-step";
import { EnvironmentRepositories } from "./_components/repositories";
import { WarmPool } from "./_components/warm-pool";

/** Screen 4's summary on the environment page: the blockers Kody hit, the frequent ones first. */
const BlockersSummary = ({
    environmentId,
    healthHref,
    canApply,
    blocked,
}: {
    environmentId: string;
    healthHref: string;
    canApply: boolean;
    /** The environment is blocked: the section stays, even empty, since the next step points here. */
    blocked: boolean;
}) => {
    const blockers = useEnvironmentBlockers(environmentId);
    const groups = useMemo(
        () => groupBlockersBySignature(blockers.data ?? []),
        [blockers.data],
    );
    // A blocker a later setup or Run cleared (the API marks it `fixed`) is history, not what to fix now.
    const open = groups.filter((g) => g.state !== "fixed");
    const fixed = groups.filter((g) => g.state === "fixed");
    const { frequent, occasional } = splitBlockersByFrequency(open);
    // Nothing to fix and nothing pointing here: no section.
    if (!blocked && !blockers.isLoading && !blockers.isError && !groups.length)
        return null;
    return (
        <RuntimeSection
            id={ENVIRONMENT_SECTION.blockers}
            title="Blockers"
            description="What stopped the app from booting or being tested, each with its fix. These are problems with the environment, not with the pull requests."
            aside={
                <NextLink
                    href={healthHref}
                    className="text-text-secondary hover:text-primary-light text-sm transition-colors hover:underline">
                    All blockers
                </NextLink>
            }>
            {blockers.isLoading ? (
                <Skeleton className="h-16 w-full" />
            ) : blockers.isError ? (
                <RuntimeErrorState
                    what="blockers"
                    error={blockers.error}
                    onRetry={() => blockers.refetch()}
                />
            ) : groups.length === 0 ? (
                <p className="text-text-secondary text-sm">
                    No blocker recorded yet: the last setup, below, says where
                    it stopped.
                </p>
            ) : (
                <div className="flex flex-col gap-4">
                    {open.length === 0 ? (
                        <p className="text-text-secondary text-sm">
                            No open blocker. What stopped the app before was
                            cleared by a later setup or Run.
                        </p>
                    ) : null}
                    {(
                        [
                            ["Seen 10+ times", frequent],
                            ["Seen fewer than 10 times", occasional],
                        ] as const
                    ).map(([label, list]) =>
                        list.length ? (
                            <div key={label} className="flex flex-col gap-2">
                                <span className="text-text-secondary text-xs font-medium">
                                    {label}
                                </span>
                                <div className="flex flex-col gap-3">
                                    {list.map((g) => (
                                        <BlockerCard
                                            key={g.signature}
                                            environmentId={environmentId}
                                            group={g}
                                            canApply={canApply}
                                            detailsHref={`${healthHref}#${blockerAnchorId(g.signature)}`}
                                        />
                                    ))}
                                </div>
                            </div>
                        ) : null,
                    )}
                    {fixed.length ? (
                        <RuntimeDisclosure
                            title={`Resolved (${fixed.length})`}
                            summary="Seen before a later setup or Run succeeded">
                            <ul className="flex flex-col gap-2">
                                {fixed.map((g) => (
                                    <li
                                        key={g.signature}
                                        className="text-text-secondary text-sm">
                                        <span className="text-text-primary">
                                            {g.title ?? g.signature}
                                        </span>
                                        {g.lastAt
                                            ? `, last seen ${new Date(g.lastAt).toLocaleString()}`
                                            : ""}
                                        {g.resolvedAt
                                            ? `, cleared ${new Date(g.resolvedAt).toLocaleString()}`
                                            : ""}
                                    </li>
                                ))}
                            </ul>
                        </RuntimeDisclosure>
                    ) : null}
                </div>
            )}
        </RuntimeSection>
    );
};

/** Shown only once Kody learned something: an empty "nothing learned" panel answers no question. */
const LessonsSection = ({
    environmentId,
    repositoryId,
    canManage,
}: {
    environmentId: string;
    repositoryId: string;
    canManage: boolean;
}) => {
    const lessons = useEnvironmentLessons(environmentId);
    if (!lessons.data?.length) return null;
    return (
        <RuntimeSection
            title="What Kody learned"
            description="Fixes that got a blocker past, proven by a clean setup right after. The next time the same blocker shows up, they are offered first.">
            <EnvironmentLessons
                environmentId={environmentId}
                repositoryId={repositoryId}
                canManage={canManage}
            />
        </RuntimeSection>
    );
};

/** Sections inside the folded settings a link can name: a blocker's "Change the machine size". */
const SETTINGS_INNER = [MACHINE_SIZE_SECTION_ID];

export const EnvironmentDetailPage = ({
    environmentId,
}: {
    environmentId: string;
}) => {
    const environment = useRuntimeEnvironment(environmentId);
    const env = environment.data ?? undefined;
    const canManageRuntime = usePermission(
        Action.Manage,
        ResourceType.RuntimeEnvironment,
    );
    // Set up and simulate: the API checks every repository the system boots.
    const canEdit = usePermissionOnEvery(
        Action.Update,
        ResourceType.CodeReviewSettings,
        env ? repositoryIdsOfEnvironment(env) : [],
    );
    const canUpdateEnvironment = usePermission(
        Action.Update,
        ResourceType.RuntimeEnvironment,
        env?.repositoryId,
    );
    // The other systems a repository is part of, and the repositories that
    // can join: the same two lists the environments page reads, once each.
    const environments = useRuntimeEnvironments();
    // The connected repositories serve only "Add repository": the owner's.
    const settings = useRuntimeSettings(canManageRuntime);
    const healthHref = `/runtime/environments/${encodeURIComponent(environmentId)}/health`;
    // A link from another screen (a Run's "Setup file") lands before the
    // sections exist: scroll to its section once the environment is loaded.
    // A section inside the settings is scrolled to by the fold that opens.
    const loaded = !!env;
    useEffect(() => {
        const id = decodeRouteParam(window.location.hash.slice(1));
        if (!loaded || !id || SETTINGS_INNER.includes(id)) return;
        const target = document.getElementById(id);
        target?.scrollIntoView?.({ behavior: "smooth" });
        // A section that sits near the top barely scrolls: mark it, so the link visibly landed somewhere.
        flash(target);
    }, [loaded]);

    if (environment.isLoading) {
        return (
            <Page.Root>
                <Page.Content>
                    <Skeleton className="h-10 w-80" />
                    <Skeleton className="h-64 w-full" />
                </Page.Content>
            </Page.Root>
        );
    }

    if (environment.isError || !env) {
        return (
            <Page.Root>
                <Page.Content>
                    {environment.isError ? (
                        <RuntimeErrorState
                            what="this environment"
                            error={environment.error}
                            onRetry={() => environment.refetch()}
                        />
                    ) : (
                        <RuntimeEmptyState title="Environment not found">
                            It may belong to another organization.{" "}
                            <NextLink
                                href="/runtime/environments"
                                className="text-primary-light hover:underline">
                                Back to environments
                            </NextLink>
                        </RuntimeEmptyState>
                    )}
                </Page.Content>
            </Page.Root>
        );
    }

    const others = environments.data ?? [];
    const step = environmentNextStep(env, others);
    // Known only from earlier Runs: no product row, so no setup, settings,
    // repositories or simulation (their routes answer 404).
    const runOnly = isRunOnlyEnvironment(env);
    const repositories = environmentRepositoriesOf(env);
    const multi = repositories.length > 1;
    // A Run boots from the last setup that finished ready: before one, there
    // is nothing to simulate and nothing to keep warm.
    const hasBake = env.setup?.state === "active" || !!env.setup?.lastActive;

    return (
        <Page.Root>
            <Page.Header>
                <div className="flex flex-col gap-2">
                    <NextLink
                        href="/runtime/environments"
                        className="text-text-tertiary flex items-center gap-1 text-xs hover:underline">
                        <ArrowLeftIcon className="size-3" aria-hidden />{" "}
                        Environments
                    </NextLink>
                    <Heading variant="h1">
                        {shortRepositoryName(env.repositoryName) ??
                            env.repositoryId}
                    </Heading>
                    <p className="text-text-secondary text-sm">
                        {multi
                            ? `How Kody boots ${namesInWords(
                                  repositories.map(repositoryLabel),
                                  3,
                              )} together to test their pull requests.`
                            : `How Kody boots ${env.repositoryName ?? "this repository"} to test its pull requests.`}
                    </p>
                </div>
                <Page.HeaderActions>
                    <Link href={healthHref} noHoverUnderline>
                        <Button
                            size="md"
                            variant="helper"
                            leftIcon={<ActivityIcon />}
                            decorative>
                            Health
                        </Button>
                    </Link>
                    {/* The next step carries the setup when it is the thing to do: one amber button, not two. */}
                    {!runOnly && step.action?.kind !== "setup" && (
                        <SetupEnvironmentButton
                            env={env}
                            size="md"
                            variant="helper"
                        />
                    )}
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content>
                <EnvironmentNextStep
                    env={env}
                    canSetUp={canEdit}
                    environments={others}
                />

                {/* What to fix comes right after the answer; the record and the configuration follow. */}
                <BlockersSummary
                    environmentId={env.environmentId}
                    healthHref={healthHref}
                    canApply={canManageRuntime && !runOnly}
                    blocked={env.state === "blocked"}
                />

                <InferredRecipe
                    env={env}
                    canPropose={canUpdateEnvironment && !runOnly}
                    setupAction={<SetupEnvironmentButton env={env} />}
                />
                <RepositoryRecipe env={env} />

                <RuntimeDisclosure
                    id={ENVIRONMENT_SECTION.setup}
                    title="Last setup"
                    summary={setupTakeaway(env)}
                    defaultOpen={isEnvironmentBusy(env)}>
                    <p className="text-text-secondary max-w-2xl text-sm">
                        A setup installs the repository on a clean machine,
                        starts it with the setup file and checks that it
                        answers. Runs start from the last setup that finished
                        ready; the pull request&apos;s code never runs here.
                    </p>
                    <EnvironmentSetupCard env={env} />
                    <KodyAttempts learn={env.setup?.learn} />
                </RuntimeDisclosure>

                <LessonsSection
                    environmentId={env.environmentId}
                    repositoryId={env.repositoryId}
                    canManage={canManageRuntime && !runOnly}
                />

                {!runOnly && hasBake && !isEnvironmentBusy(env) && (
                    <RuntimeSection
                        id={ENVIRONMENT_SECTION.simulation}
                        title="Simulate on past PRs"
                        description="Runs Kody Runtime on pull requests already merged or open, with the current setup, to see what it would have said. Nothing is posted.">
                        <SimulateOnPastPrs
                            environmentId={env.environmentId}
                            repositoryName={env.repositoryName}
                            repositories={multi ? repositories : undefined}
                            canEdit={canEdit}
                        />
                    </RuntimeSection>
                )}

                {!runOnly && (
                    <EnvironmentSuiteSection
                        environmentId={env.environmentId}
                        canManage={canManageRuntime}
                    />
                )}

                {!runOnly && env.repositories && (
                    <EnvironmentRepositories
                        env={env}
                        environments={others}
                        connected={settings.data?.repositories}
                        canManage={canManageRuntime}
                    />
                )}

                {!runOnly && (
                    <EnvironmentPreviewSection
                        environmentId={env.environmentId}
                        repositoryIds={repositoryIdsOfEnvironment(env)}
                        previewSecrets={env.previewSecrets}
                    />
                )}

                {/* The defaults fit most repositories: the settings wait behind one line that says what they are. */}
                {!runOnly && (
                    <RuntimeDisclosure
                        id={ENVIRONMENT_SECTION.settings}
                        title="Settings"
                        summary={settingsTakeaway(env)}
                        openFor={SETTINGS_INNER}>
                        <div className="flex flex-col gap-8">
                            {env.machineSize !== undefined && (
                                <RuntimeSubsection
                                    id={MACHINE_SIZE_SECTION_ID}
                                    title="Machine size"
                                    description="The memory and CPUs each build and service of this environment gets. Raise it when a build runs out of memory.">
                                    <MachineSizeSetting
                                        key={env.machineSize ?? "default"}
                                        environmentId={env.environmentId}
                                        setting={env.machineSize}
                                        bootedAt={env.setup?.machineSize}
                                        hasSetup={!!env.setup}
                                        canEdit={canManageRuntime}
                                        selfHosted={
                                            env.cellOwner === "customer"
                                        }
                                        setupAction={
                                            <SetupEnvironmentButton env={env} />
                                        }
                                    />
                                </RuntimeSubsection>
                            )}

                            {env.forkPullRequests !== undefined && (
                                <RuntimeSubsection
                                    title="Pull requests from forks"
                                    description="A pull request from a fork runs code anyone can write. Choose whether it runs, and who lets it.">
                                    <ForkPullRequestsSetting
                                        key={env.forkPullRequests}
                                        environmentId={env.environmentId}
                                        setting={env.forkPullRequests}
                                        effective={
                                            env.effectiveForkPullRequests
                                        }
                                        canEdit={canManageRuntime}
                                    />
                                </RuntimeSubsection>
                            )}

                            {env.pool && (
                                <RuntimeSubsection
                                    title="Machines kept ready"
                                    description="Clean machines from the last setup, waiting for the next Run, so it starts without booting.">
                                    {hasBake ? (
                                        <WarmPool
                                            key={`${env.pool.setting ?? ""}:${JSON.stringify(env.pool.policy ?? null)}`}
                                            environmentId={env.environmentId}
                                            pool={env.pool}
                                            canEdit={canManageRuntime}
                                            hasBake={hasBake}
                                            bootP50Ms={env.metrics?.readyP50Ms}
                                        />
                                    ) : (
                                        <p className="text-text-secondary text-sm">
                                            Available once a setup finishes
                                            ready: the machines are copies of
                                            it.
                                        </p>
                                    )}
                                </RuntimeSubsection>
                            )}

                            <RuntimeSubsection
                                title="Approved outbound hosts"
                                description="Hosts this environment may reach beyond the Kodus recommended list and the org list (Settings, Runtime, Outbound access). Reads only unless full access was asked for; approvals do not expire, and each row says when a machine last got it.">
                                <EgressApprovalsList
                                    scopeId={env.environmentId}
                                    approvals={env.egressApprovals ?? []}
                                    canChange={canManageRuntime}
                                />
                                {canManageRuntime && (
                                    <ApproveHostForm
                                        environmentId={env.environmentId}
                                    />
                                )}
                            </RuntimeSubsection>
                        </div>
                    </RuntimeDisclosure>
                )}
            </Page.Content>
        </Page.Root>
    );
};
