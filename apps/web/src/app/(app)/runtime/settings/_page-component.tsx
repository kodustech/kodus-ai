"use client";

import { useState } from "react";
import NextLink from "next/link";
import { OutboundAccessSection } from "@components/runtime/egress-access";
import { RuntimeErrorState } from "@components/runtime/empty-state";
import { ExercisedLinesThreshold } from "@components/runtime/exercised-lines-threshold";
import { MachineHostPrice } from "@components/runtime/machine-host-price";
import { MachineMinuteLimit } from "@components/runtime/machine-minute-limit";
import { RuntimePreviewSettingsSection } from "@components/runtime/preview-settings";
import { RuntimeHeader } from "@components/runtime/runtime-header";
import { RuntimeSecretsSection } from "@components/runtime/runtime-secrets";
import { SandboxCapacitySection } from "@components/runtime/sandbox-capacity";
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
import { RUNTIME_USAGE_HREF } from "@services/runtime/model/usage-report";
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
import { isSelfHosted } from "src/core/utils/self-hosted";

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
    // The token budget, the exercised-lines threshold and the host price are organization-wide.
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
    // Absent from an API older than the setting: the field is not offered.
    const thresholdDefault =
        settings.data?.exercisedLinesThresholdDefaultPercent;
    const threshold = settings.data?.exercisedLinesThresholdPercent ?? null;
    const hostPrice = settings.data?.machineUsdPerHostHour;

    return (
        <Page.Root>
            <RuntimeHeader />
            <Page.Content>
                <p className="text-text-secondary text-sm">
                    When Kody Runtime runs on each repository, and who may ask
                    for it, is set in{" "}
                    <NextLink
                        href="/settings/code-review/global/routing"
                        className="underline">
                        Code Review &gt; Routing
                    </NextLink>
                    . Today&apos;s machine time and its daily limit are in{" "}
                    <NextLink href={RUNTIME_USAGE_HREF} className="underline">
                        Usage
                    </NextLink>
                    .
                </p>

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

                {/* The Runtime tab of Usage is the org owner's (checkRole OWNER), the same people as canStop. */}
                {canStop && (
                    <RuntimeSection
                        title="Usage"
                        description="What your Runs, setups and sandbox sessions used each month: machine time, LLM tokens and their estimated cost, Run by Run, with a CSV export."
                        aside={
                            <NextLink href={RUNTIME_USAGE_HREF}>
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
