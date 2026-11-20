"use client";

import { useState } from "react";
import NextLink from "next/link";
import { OutboundAccessSection } from "@components/runtime/egress-access";
import { RuntimeErrorState } from "@components/runtime/empty-state";
import { ExercisedLinesThreshold } from "@components/runtime/exercised-lines-threshold";
import { MachineHostPrice } from "@components/runtime/machine-host-price";
import { MachineMinuteLimit } from "@components/runtime/machine-minute-limit";
import { SandboxCapacitySection } from "@components/runtime/sandbox-capacity";
import { RuntimePreviewSettingsSection } from "@components/runtime/preview-settings";
import { RuntimeHeader } from "@components/runtime/runtime-header";
import { RuntimeSecretsSection } from "@components/runtime/runtime-secrets";
import { RuntimeSection } from "@components/runtime/section";
import { Button } from "@components/ui/button";
import { ConfirmModal } from "@components/ui/confirm-modal";
import { Input } from "@components/ui/input";
import { Page } from "@components/ui/page";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { Skeleton } from "@components/ui/skeleton";
import {
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";
import { toast } from "@components/ui/toaster/use-toast";
import { isSelfHosted } from "src/core/utils/self-hosted";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type {
    RuntimeMode,
    RuntimeRepositorySettings,
    RuntimeWhoCanAsk,
} from "@services/runtime/contracts";
import {
    RUNTIME_MODE_OPTIONS,
    WHO_CAN_ASK_OPTIONS,
} from "@services/runtime/labels";
import {
    membershipsByRepository,
    ownModeNote,
} from "@services/runtime/model/environment-repositories";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import { machineMinutesSummary } from "@services/runtime/model/machine-minutes";
import { modeOf } from "@services/runtime/model/rules";
import {
    useResumeRuntime,
    useRuntimeEnvironments,
    useRuntimeMachineMinutes,
    useRuntimeSettings,
    useStopRuntime,
    useUpdateRuntimeOrgSettings,
    useUpdateRuntimeRepositorySettings,
} from "@services/runtime/queries";
import {
    ActivityIcon,
    BarChart3Icon,
    OctagonXIcon,
    PlayIcon,
    ServerIcon,
} from "lucide-react";

const repositoryPage = (repositoryId: string) =>
    `/settings/code-review/${encodeURIComponent(repositoryId)}/kody-runtime`;

/**
 * One repository: when the Runtime runs (`mode`, the one on/off switch the
 * UI writes; the API derives `pilot` from it) and who may ask for it. Rules
 * themselves are edited on the repository's Runtime page.
 */
const RepositoryRow = ({
    repository,
    note,
}: {
    repository: RuntimeRepositorySettings;
    /** It is a member of another environment: what its own mode governs (ownModeNote). */
    note?: string;
}) => {
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repository.repositoryId,
    );
    const update = useUpdateRuntimeRepositorySettings();
    const disabled = !canEdit || update.isPending;
    const name = repository.repositoryName ?? repository.repositoryId;
    const mode = modeOf(repository);
    const hasRules = (repository.rules?.length ?? 0) > 0;
    const save = (patch: {
        mode?: RuntimeMode;
        whoCanAsk?: RuntimeWhoCanAsk;
    }) =>
        update.mutate(
            { repositoryId: repository.repositoryId, ...patch },
            {
                onError: (error) =>
                    toast({
                        variant: "danger",
                        title: `Couldn't save ${name}`,
                        description: runtimeErrorMessage(error, {
                            fallback: "Try again in a moment.",
                        }),
                    }),
            },
        );

    return (
        <TableRow>
            <TableCell className="font-medium">
                <NextLink
                    href={repositoryPage(repository.repositoryId)}
                    className="hover:underline">
                    {name}
                </NextLink>
                {note ? (
                    <p className="text-text-secondary mt-1 max-w-sm text-xs font-normal">
                        {note}
                    </p>
                ) : null}
            </TableCell>
            <TableCell>
                <Select
                    value={mode}
                    disabled={disabled}
                    onValueChange={(value) =>
                        save({ mode: value as RuntimeMode })
                    }>
                    <SelectTrigger
                        className="w-48"
                        aria-label={`When Kody Runtime runs on ${name}`}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {RUNTIME_MODE_OPTIONS.map((option) => (
                            <SelectItem
                                key={option.value}
                                value={option.value}
                                // Rules need rules: they are written on the repository's page.
                                disabled={
                                    option.value === "rules" && !hasRules
                                }>
                                {option.label}
                                {option.value === "rules" && hasRules
                                    ? ` (${repository.rules!.length})`
                                    : ""}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </TableCell>
            <TableCell>
                <Select
                    value={repository.whoCanAsk}
                    disabled={disabled || mode === "off"}
                    onValueChange={(value) =>
                        save({ whoCanAsk: value as RuntimeWhoCanAsk })
                    }>
                    <SelectTrigger
                        className="w-64"
                        aria-label={`Who may ask @kody runtime on ${name}`}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {WHO_CAN_ASK_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </TableCell>
        </TableRow>
    );
};

const TokenBudget = ({
    value,
    canEdit,
}: {
    value: number | null | undefined;
    canEdit: boolean;
}) => {
    // Remounted with a new `key` when the saved value changes.
    const [draft, setDraft] = useState(value != null ? String(value) : "");
    const update = useUpdateRuntimeOrgSettings();
    const parsed = draft.trim() === "" ? null : Number(draft);
    const valid = parsed === null || (Number.isInteger(parsed) && parsed > 0);
    const dirty = (value ?? null) !== parsed;

    return (
        <form
            className="flex flex-wrap items-center gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                if (!valid || !dirty) return;
                update.mutate(
                    { tokenBudgetPerDay: parsed },
                    {
                        onSuccess: () =>
                            toast({
                                variant: "success",
                                title: "Token budget saved",
                            }),
                        onError: (error) =>
                            toast({
                                variant: "danger",
                                title: "Couldn't save the token budget",
                                description: runtimeErrorMessage(error, {
                                    fallback: "Try again in a moment.",
                                }),
                            }),
                    },
                );
            }}>
            {/* Input's wrapper grows (flex-1): a fixed-width box keeps the field short. */}
            <div className="w-56">
                <Input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    aria-label="Tokens per day"
                    aria-invalid={!valid}
                    placeholder="No limit"
                    value={draft}
                    disabled={!canEdit}
                    onChange={(event) => setDraft(event.target.value)}
                />
            </div>
            <span className="text-text-tertiary text-sm">tokens per day</span>
            <Button
                type="submit"
                size="md"
                variant="primary"
                disabled={!canEdit || !valid || !dirty}
                loading={update.isPending}>
                Save
            </Button>
        </form>
    );
};

const minutes = (n: number) => `${n.toLocaleString()} min`;

/** Today's machine minutes of the organization: used, held by machines still running, the reset, and the limit that holds. */
const MachineTimeToday = ({ canEdit }: { canEdit: boolean }) => {
    const today = useRuntimeMachineMinutes();
    if (today.isLoading) return <Skeleton className="h-10 w-80" />;
    if (today.isError || !today.data)
        return (
            <p className="text-text-secondary text-sm">
                Machine time is not available on this deployment right now.
            </p>
        );
    const s = machineMinutesSummary(today.data);
    return (
        <div className="flex flex-col gap-1 text-sm">
            <p className="text-text-primary">
                <span className="font-semibold">{minutes(s.usedMinutes)}</span>
                {s.limitMinutes !== null
                    ? ` of ${minutes(s.limitMinutes)} used`
                    : " used (no daily limit)"}
                {s.runningMachines > 0 &&
                    ` · ${minutes(s.heldByRunningMinutes)} more held by ${s.runningMachines} machine${s.runningMachines === 1 ? "" : "s"} still running`}
            </p>
            {s.exhausted ? (
                <p className="text-warning text-sm" role="status">
                    {s.waitWords} Resets in {s.resetsIn}.
                </p>
            ) : (
                <p className="text-text-tertiary text-xs">
                    {s.remainingMinutes !== null
                        ? `${minutes(s.remainingMinutes)} left · `
                        : ""}
                    Resets at 00:00 UTC, in {s.resetsIn}.
                </p>
            )}
            <div className="border-card-lv3 mt-3 border-t pt-3">
                <MachineMinuteLimit
                    key={String(today.data.orgLimitMinutes ?? "")}
                    today={today.data}
                    canEdit={canEdit}
                />
            </div>
        </div>
    );
};

/** For an incident: stop every Run and machine of the organization, and reopen after. */
const StopAndResume = () => {
    const [confirming, setConfirming] = useState<"stop" | "resume">();
    const stop = useStopRuntime();
    const resume = useResumeRuntime();
    const pending = stop.isPending || resume.isPending;
    const onError = (title: string) => (error: unknown) =>
        toast({
            variant: "danger",
            title,
            description: runtimeErrorMessage(error, {
                fallback: "Try again in a moment.",
                403: "Only the owner of the organization can do this.",
            }),
        });
    return (
        <div className="flex flex-wrap items-center gap-3">
            <Button
                size="md"
                variant="error"
                leftIcon={<OctagonXIcon />}
                onClick={() => setConfirming("stop")}>
                Stop Kody Runtime
            </Button>
            <Button
                size="md"
                variant="secondary"
                leftIcon={<PlayIcon />}
                onClick={() => setConfirming("resume")}>
                Resume after a stop
            </Button>
            <ConfirmModal
                open={confirming === "stop"}
                title="Stop Kody Runtime for this organization?"
                description="Cancels every Run in progress, refuses new machines, destroys the running ones and revokes pending download tokens. Reviews keep working."
                confirmText="Stop everything"
                loading={pending}
                onCancel={() => setConfirming(undefined)}
                onConfirm={() =>
                    stop.mutate("org", {
                        onSuccess: () => {
                            setConfirming(undefined);
                            toast({
                                variant: "warning",
                                title: "Kody Runtime stopped for this organization",
                                description:
                                    "Resume it here once the incident is over.",
                            });
                        },
                        onError: onError("Couldn't stop Kody Runtime"),
                    })
                }
            />
            <ConfirmModal
                open={confirming === "resume"}
                title="Resume Kody Runtime for this organization?"
                description="Clears the organization's stop: new Runs are accepted again. Runs cancelled by the stop are not restarted; use Run again on them."
                confirmText="Resume"
                loading={pending}
                onCancel={() => setConfirming(undefined)}
                onConfirm={() =>
                    resume.mutate("org", {
                        onSuccess: () => {
                            setConfirming(undefined);
                            toast({
                                variant: "success",
                                title: "Kody Runtime resumed",
                            });
                        },
                        onError: onError("Couldn't resume Kody Runtime"),
                    })
                }
            />
        </div>
    );
};

export const RuntimeOrgSettingsPage = () => {
    const settings = useRuntimeSettings();
    // The token budget, the machine-minute limit, the exercised-lines threshold and the host price are organization-wide.
    const canEditOrg = usePermission(
        Action.Update,
        ResourceType.OrganizationSettings,
    );
    // POST /runtime/stop and /stop/clear: the org owner (checkRole OWNER),
    // the same people as Manage on RuntimeEnvironment in ROLE_POLICIES.
    const canStop = usePermission(
        Action.Manage,
        ResourceType.RuntimeEnvironment,
    );
    // GET /runtime/egress: Read on RuntimeEnvironment (a billing manager has none).
    const canReadEgress = usePermission(
        Action.Read,
        ResourceType.RuntimeEnvironment,
    );
    const repositories = settings.data?.repositories ?? [];
    // Absent from an API older than the setting: the field is not offered.
    const thresholdDefault =
        settings.data?.exercisedLinesThresholdDefaultPercent;
    const threshold = settings.data?.exercisedLinesThresholdPercent ?? null;
    const hostPrice = settings.data?.machineUsdPerHostHour;
    // Where each repository is a member, so a member's row says what its own mode governs.
    const environments = useRuntimeEnvironments();
    const memberships = membershipsByRepository(environments.data ?? []);

    return (
        <Page.Root>
            <RuntimeHeader />
            <Page.Content>
                <RuntimeSection
                    title="Repositories"
                    description="When Kody Runtime runs on each repository's own environment, and who may ask for it. Turning a repository on creates its environment; a member of another environment runs there by that environment's settings. Rules are written on the repository's Runtime page.">
                    {settings.isLoading ? (
                        <Skeleton className="h-32 w-full" />
                    ) : settings.isError ? (
                        // Never a table of defaults: it would read as saved, and a change would overwrite.
                        <RuntimeErrorState
                            what="the Runtime settings"
                            error={settings.error}
                            onRetry={() => settings.refetch()}
                        />
                    ) : repositories.length === 0 ? (
                        <p className="text-text-secondary text-sm">
                            No repository connected.
                        </p>
                    ) : (
                        <TableContainer>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Repository</TableHead>
                                        <TableHead>Runs</TableHead>
                                        <TableHead>
                                            Who may ask @kody runtime
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {repositories.map((repository) => (
                                        <RepositoryRow
                                            key={repository.repositoryId}
                                            repository={repository}
                                            note={ownModeNote(
                                                memberships.get(
                                                    repository.repositoryId,
                                                ),
                                            )}
                                        />
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    )}
                </RuntimeSection>

                <RuntimeSection
                    title="Machine time"
                    description="Minutes of Kody's machines (setups, Runs, environment sessions) the organization used today (UTC), against its daily limit. A machine still running holds its whole ceiling until it ends.">
                    <MachineTimeToday canEdit={canEditOrg} />
                </RuntimeSection>

                <RuntimeSection
                    title="Token budget"
                    description="Enforced by the LLM gateway for every Run of the organization. When the day's budget runs out, new Runs are skipped and the check says why.">
                    {settings.isLoading ? (
                        <Skeleton className="h-10 w-80" />
                    ) : settings.data ? (
                        <TokenBudget
                            key={String(settings.data.tokenBudgetPerDay ?? "")}
                            value={settings.data.tokenBudgetPerDay}
                            canEdit={canEditOrg}
                        />
                    ) : (
                        <p className="text-text-secondary text-sm">
                            Available once the settings load.
                        </p>
                    )}
                </RuntimeSection>

                {/* PATCH /runtime/settings: Update on OrganizationSettings, as the token budget. */}
                <RuntimeSection
                    title="Changed lines exercised"
                    description="How much of a pull request's changed code must run during a Run's checks for the Run to say No regressions. It applies to every repository of the organization.">
                    {settings.isLoading ? (
                        <Skeleton className="h-10 w-80" />
                    ) : thresholdDefault !== undefined ? (
                        <ExercisedLinesThreshold
                            key={String(threshold ?? "")}
                            value={threshold}
                            defaultPercent={thresholdDefault}
                            canEdit={canEditOrg}
                        />
                    ) : (
                        <p className="text-text-secondary text-sm">
                            Available once the settings load.
                        </p>
                    )}
                </RuntimeSection>

                {/* PATCH /runtime/settings: Update on OrganizationSettings, as the token budget. */}
                <RuntimeSection
                    title="Price of your own hosts"
                    description="What one hour of one of your own hosts costs, so a Run's machine time on them gets a price. It applies to every host the organization registered.">
                    {settings.isLoading ? (
                        <Skeleton className="h-10 w-80" />
                    ) : hostPrice !== undefined ? (
                        <MachineHostPrice
                            key={String(hostPrice ?? "")}
                            value={hostPrice}
                            canEdit={canEditOrg}
                        />
                    ) : (
                        <p className="text-text-secondary text-sm">
                            Available once the settings load.
                        </p>
                    )}
                </RuntimeSection>

                {/* /runtime/settings/health is the org owner's (checkRole OWNER), the same people as canStop. */}
                {canStop && (
                    <RuntimeSection
                        title="Health"
                        description="How Kody Runtime is doing for your organization: setups and Runs, boot times, anything stuck, what stopped setups and Runs, your own hosts, and today's cost."
                        aside={
                            <NextLink href="/runtime/settings/health">
                                <Button
                                    size="md"
                                    variant="secondary"
                                    decorative
                                    leftIcon={<ActivityIcon />}>
                                    Open health
                                </Button>
                            </NextLink>
                        }>
                        <p className="text-text-tertiary text-xs">
                            Read from what Kody Runtime records; a figure it
                            cannot read says Not measured.
                        </p>
                    </RuntimeSection>
                )}

                {/* /runtime/settings/usage is the org owner's (checkRole OWNER), the same people as canStop. */}
                {canStop && (
                    <RuntimeSection
                        title="Usage"
                        description="What your Runs, setups and sandbox sessions used each month: machine time, LLM tokens and their estimated cost, Run by Run, with a CSV export."
                        aside={
                            <NextLink href="/runtime/settings/usage">
                                <Button
                                    size="md"
                                    variant="secondary"
                                    decorative
                                    leftIcon={<BarChart3Icon />}>
                                    Open usage
                                </Button>
                            </NextLink>
                        }>
                        <p className="text-text-tertiary text-xs">
                            Estimates from list prices and the time machines
                            were held, not a bill.
                        </p>
                    </RuntimeSection>
                )}

                {/* /runtime/cells/registration-tokens is the org owner's (checkRole OWNER), the same people as canStop. */}
                {canStop && (
                    <RuntimeSection
                        title="Hosts"
                        description="Run Kody's machines on a Linux host of your own: make a single-use registration token, run the installer on the host, and revoke tokens you no longer need."
                        aside={
                            <NextLink href="/runtime/settings/cells">
                                <Button
                                    size="md"
                                    variant="secondary"
                                    decorative
                                    leftIcon={<ServerIcon />}>
                                    Open hosts
                                </Button>
                            </NextLink>
                        }>
                        <p className="text-text-tertiary text-xs">
                            Each token works once, for 15 minutes; it is shown
                            only when it is made.
                        </p>
                    </RuntimeSection>
                )}

                {/* GET /runtime/egress is every environment reader's; changes are the owner's (canStop). */}
                {canReadEgress && <OutboundAccessSection canChange={canStop} />}

                {/* /runtime/secrets is the org owner's (checkRole OWNER), the same people as canStop. */}
                {canStop && <RuntimeSecretsSection />}

                {/* /runtime/settings/preview and the preview activity are the org owner's (checkRole OWNER). */}
                {canStop && <RuntimePreviewSettingsSection />}

                {/* /sandbox-capacity is the org owner's and self-hosted only (404 on Kodus Cloud). */}
                {canStop && isSelfHosted && <SandboxCapacitySection />}

                {canStop && (
                    <RuntimeSection
                        title="Stop"
                        description="For an incident: stops every Run and machine of this organization at once. Resume reopens it.">
                        <StopAndResume />
                    </RuntimeSection>
                )}
            </Page.Content>
        </Page.Root>
    );
};
