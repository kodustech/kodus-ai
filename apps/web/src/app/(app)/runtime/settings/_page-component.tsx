"use client";

import { useState } from "react";
import NextLink from "next/link";
import { OutboundAccessSection } from "@components/runtime/egress-access";
import { ExercisedLinesThreshold } from "@components/runtime/exercised-lines-threshold";
import { MachineHostPrice } from "@components/runtime/machine-host-price";
import { RuntimePreviewSettingsSection } from "@components/runtime/preview-settings";
import { RuntimeHeader } from "@components/runtime/runtime-header";
import { RuntimeSecretsSection } from "@components/runtime/runtime-secrets";
import { SandboxCapacitySection } from "@components/runtime/sandbox-capacity";
import { RuntimeSection } from "@components/runtime/section";
import { Button } from "@components/ui/button";
import { ConfirmModal } from "@components/ui/confirm-modal";
import { Input } from "@components/ui/input";
import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";
import { toast } from "@components/ui/toaster/use-toast";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";

import type {} from "@services/runtime/contracts";

import { runtimeErrorMessage } from "@services/runtime/model/errors";
import { settingsStatusLine } from "@services/runtime/model/health";
import { RUNTIME_USAGE_HREF } from "@services/runtime/model/usage-report";
import {
    useResumeRuntime,
    useRuntimeEnvironments,
    useRuntimeHealth,
    useRuntimeSettings,
    useStopRuntime,
    useUpdateRuntimeOrgSettings,
} from "@services/runtime/queries";
import {
    ChevronRightIcon,
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
    const environments = useRuntimeEnvironments();
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
    const health = useRuntimeHealth(canStop);
    const status = health.data ? settingsStatusLine(health.data) : undefined;
    // Absent from an API older than the setting: the field is not offered.
    const thresholdDefault =
        settings.data?.exercisedLinesThresholdDefaultPercent;
    const threshold = settings.data?.exercisedLinesThresholdPercent ?? null;
    const hostPrice = settings.data?.machineUsdPerHostHour;

    return (
        <Page.Root>
            <RuntimeHeader />
            <Page.Content>
                <p
                    className="text-sm font-medium"
                    role="status"
                    aria-live="polite">
                    {health.data ? (
                        <span
                            className={
                                status?.ok ? "text-success" : "text-danger"
                            }>
                            <span aria-hidden>{status?.ok ? "● " : "▲ "}</span>
                            {status?.text}
                        </span>
                    ) : (
                        <span className="text-text-secondary">
                            {canStop && health.isLoading
                                ? "Checking…"
                                : "Status unavailable"}
                        </span>
                    )}
                    {canStop && (
                        <>
                            {" · "}
                            <NextLink
                                href="/runtime/settings/health"
                                className="text-primary-light font-normal underline-offset-2 hover:underline">
                                Health
                            </NextLink>
                        </>
                    )}
                </p>
                <p className="text-text-secondary text-sm">
                    <NextLink
                        href="/runtime/environments"
                        className="text-primary-light underline-offset-2 hover:underline">
                        {environments.data
                            ? `${environments.data.length} ${environments.data.length === 1 ? "environment" : "environments"}`
                            : "Environments"}
                    </NextLink>
                </p>
                {canStop && (
                    <RuntimeSection
                        title="Pause or resume"
                        description="Stops every Run and machine at once, for an incident.">
                        <StopAndResume />
                    </RuntimeSection>
                )}
                <p className="text-text-secondary text-sm">
                    When it runs and who may ask:{" "}
                    <NextLink
                        href="/settings/code-review/global/routing"
                        className="underline">
                        Code Review &gt; Routing
                    </NextLink>
                    . Machine time and cost:{" "}
                    <NextLink href={RUNTIME_USAGE_HREF} className="underline">
                        Usage
                    </NextLink>
                    .
                </p>
                <details className="group/advanced">
                    <summary className="text-text-primary focus-visible:ring-ring flex cursor-pointer list-none items-center gap-1 rounded text-sm font-medium focus-visible:ring-3 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                        <ChevronRightIcon
                            aria-hidden
                            className="size-4 transition-transform group-open/advanced:rotate-90"
                        />
                        Advanced settings
                    </summary>
                    <div className="mt-4 flex flex-col gap-6">
                        <RuntimeSection
                            title="Token budget"
                            description="Daily LLM limit for all Runs. When it runs out, new Runs are skipped.">
                            {settings.isLoading ? (
                                <Skeleton className="h-10 w-80" />
                            ) : settings.data ? (
                                <TokenBudget
                                    key={String(
                                        settings.data.tokenBudgetPerDay ?? "",
                                    )}
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
                            description="Share of a PR's changed lines the checks must run to say No regressions.">
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
                            description="Cost of one hour on your own hosts, to price machine time.">
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

                        {/* /runtime/cells/registration-tokens is the org owner's (checkRole OWNER), the same people as canStop. */}
                        {canStop && (
                            <RuntimeSection
                                title="Hosts"
                                description="Run Kody's machines on a Linux host of your own."
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
                                    Registration tokens work once, for 15
                                    minutes.
                                </p>
                            </RuntimeSection>
                        )}

                        {/* GET /runtime/egress is every environment reader's; changes are the owner's (canStop). */}
                        {canReadEgress && (
                            <OutboundAccessSection canChange={canStop} />
                        )}

                        {/* /runtime/secrets is the org owner's (checkRole OWNER), the same people as canStop. */}
                        {canStop && <RuntimeSecretsSection />}

                        {/* /runtime/settings/preview and the preview activity are the org owner's (checkRole OWNER). */}
                        {canStop && <RuntimePreviewSettingsSection />}

                        {/* /sandbox-capacity is the org owner's and self-hosted only (404 on Kodus Cloud). */}
                        {canStop && isSelfHosted && <SandboxCapacitySection />}
                    </div>
                </details>
            </Page.Content>
        </Page.Root>
    );
};
