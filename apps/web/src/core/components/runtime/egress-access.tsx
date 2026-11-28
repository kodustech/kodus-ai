"use client";

import { useState } from "react";
import { RuntimeErrorState } from "@components/runtime/empty-state";
import { RuntimeSection } from "@components/runtime/section";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { Skeleton } from "@components/ui/skeleton";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import type { EgressApproval, EgressWhoMayAdd } from "@services/runtime/contracts";
import { checkEgressHost } from "@services/runtime/model/egress-host";
import {
    egressLastUseLabel,
    egressSourceLabel,
    egressTierLabel,
    RECOMMENDED_OFF_WARNING,
    sortEgressApprovals,
    WHO_MAY_ADD_LABEL,
} from "@services/runtime/model/egress";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    useApproveEgressHost,
    useOrgEgress,
    useRevokeEgressHost,
    useUpdateOrgEgressSettings,
} from "@services/runtime/queries";

import { RelativeTime } from "./relative-time";
import { StatusChip } from "./status-chip";

// The org's outbound access (docs/runtime/egress-allowlist.md §9): approvals
// with their tier, who and when, their last use and a Revoke; the org list;
// the Kodus recommended list and the org's switch for it; who may add hosts.

const REVOKE_ERRORS = {
    fallback: "Try again in a moment.",
    403: "Only the owner, or a repo admin when the org allows it, can change outbound hosts.",
};

/** One scope's approvals (an environment, or "*" for the org list). */
export const EgressApprovalsList = ({
    scopeId,
    approvals,
    canChange,
}: {
    scopeId: string;
    approvals: EgressApproval[];
    canChange: boolean;
}) => {
    const revoke = useRevokeEgressHost();
    const [confirming, setConfirming] = useState<string>();
    if (!approvals.length)
        return (
            <p className="text-text-secondary text-sm">
                None: only the Kodus recommended list and the list set on the server that runs the machines.
            </p>
        );
    return (
        <ul className="flex flex-col gap-2">
            {sortEgressApprovals(approvals).map((a) => (
                <li
                    key={a.host}
                    aria-label={a.host}
                    className={`flex flex-wrap items-center gap-2 text-sm ${a.revokedAt ? "opacity-60" : ""}`}>
                    <span className="font-mono">{a.host}</span>
                    <StatusChip tone={a.mode === "inspected" ? "success" : "warning"}>
                        {egressTierLabel(a)}
                    </StatusChip>
                    <span className="text-text-tertiary text-xs">
                        {egressSourceLabel(a)}
                        {a.approvedBy ? ` by ${a.approvedBy}` : ""} ·{" "}
                        <RelativeTime at={a.approvedAt} /> ·{" "}
                        {egressLastUseLabel(a)}
                        {a.revokedAt ? (
                            <>
                                {a.revokedBy ? ` by ${a.revokedBy}` : ""}{" "}
                                <RelativeTime at={a.revokedAt} />
                            </>
                        ) : a.lastSentAt ? (
                            <>
                                {" "}
                                <RelativeTime at={a.lastSentAt} />
                            </>
                        ) : null}
                    </span>
                    {canChange && !a.revokedAt && (
                        <Button
                            size="xs"
                            variant={confirming === a.host ? "secondary" : "helper"}
                            loading={revoke.isPending && confirming === a.host}
                            aria-label={confirming === a.host ? `Confirm revoking ${a.host}` : `Revoke ${a.host}`}
                            onClick={() =>
                                confirming !== a.host
                                    ? setConfirming(a.host)
                                    : revoke.mutate(
                                          { environmentId: scopeId, host: a.host },
                                          {
                                              onSuccess: () =>
                                                  toast({
                                                      variant: "success",
                                                      title: `${a.host} revoked`,
                                                      description: "Live machines lose it now; new ones never resolve it.",
                                                  }),
                                              onError: (error) =>
                                                  toast({
                                                      variant: "danger",
                                                      title: `Couldn't revoke ${a.host}`,
                                                      description: runtimeErrorMessage(error, REVOKE_ERRORS),
                                                  }),
                                              onSettled: () => setConfirming(undefined),
                                          },
                                      )
                            }>
                            {confirming === a.host ? "Revoke now" : "Revoke"}
                        </Button>
                    )}
                </li>
            ))}
        </ul>
    );
};

const AddToOrgList = () => {
    const approve = useApproveEgressHost();
    const [host, setHost] = useState("");
    const [fullAccess, setFullAccess] = useState(false);
    const checked = checkEgressHost(host);
    return (
        <form
            className="flex flex-wrap items-center gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                if (!checked.ok) return;
                approve.mutate(
                    { environmentId: "*", host: checked.host, mode: fullAccess ? "passthrough" : "inspected", source: "settings" },
                    {
                        onSuccess: () => {
                            toast({ variant: "success", title: `${checked.host} added to the org list` });
                            setHost("");
                            setFullAccess(false);
                        },
                        onError: (error) =>
                            toast({
                                variant: "danger",
                                title: `Couldn't add ${checked.host}`,
                                description: runtimeErrorMessage(error, REVOKE_ERRORS),
                            }),
                    },
                );
            }}>
            <Input
                aria-label="Host for every environment"
                placeholder="cdn.example.com"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                className="w-72"
            />
            <span className="flex items-center gap-2 text-xs">
                <Switch
                    size="sm"
                    checked={fullAccess}
                    onCheckedChange={setFullAccess}
                    aria-label="Full access (uploads too)"
                />
                Full access (uploads too)
            </span>
            <Button size="md" variant="secondary" type="submit" disabled={!checked.ok} loading={approve.isPending}>
                Add to the org list
            </Button>
        </form>
    );
};

/** Settings, Runtime: the org's outbound access, for every member to read and the owner to change. */
export const OutboundAccessSection = ({ canChange }: { canChange: boolean }) => {
    const egress = useOrgEgress();
    const update = useUpdateOrgEgressSettings();
    const [confirmOff, setConfirmOff] = useState(false);
    const settings = egress.data?.settings;
    const save = (body: { recommendedEnabled?: boolean; whoMayAdd?: EgressWhoMayAdd }) =>
        update.mutate(body, {
            onSuccess: () => toast({ variant: "success", title: "Outbound access saved", description: "New setups and Runs use it." }),
            onError: (error) => toast({ variant: "danger", title: "Couldn't save", description: runtimeErrorMessage(error, REVOKE_ERRORS) }),
        });
    return (
        <RuntimeSection
            id="outbound-access"
            title="Outbound access"
            description="The hosts Kody's machines may reach. Kodus's recommended list covers package registries and download hosts, read only; the org list adds hosts for every environment; an environment adds its own.">
            {egress.isLoading ? (
                <Skeleton className="h-24 w-full" />
            ) : egress.isError || !egress.data || !settings ? (
                <RuntimeErrorState what="the outbound access" error={egress.error} onRetry={() => egress.refetch()} />
            ) : (
                <div className="flex flex-col gap-5">
                    <div className="flex flex-col gap-2">
                        <span className="flex items-center gap-2 text-sm">
                            <Switch
                                size="sm"
                                checked={settings.recommendedEnabled}
                                disabled={!canChange}
                                loading={update.isPending}
                                aria-label="Use the Kodus recommended list"
                                onCheckedChange={(on) => (on ? save({ recommendedEnabled: true }) : setConfirmOff(true))}
                            />
                            Use the Kodus recommended list (version {egress.data.recommended.version})
                        </span>
                        {confirmOff && (
                            <div role="alert" className="flex flex-col gap-2">
                                <p className="text-warning text-xs">{RECOMMENDED_OFF_WARNING}</p>
                                <div className="flex gap-2">
                                    <Button size="xs" variant="secondary" onClick={() => { save({ recommendedEnabled: false }); setConfirmOff(false); }}>
                                        Turn it off
                                    </Button>
                                    <Button size="xs" variant="cancel" onClick={() => setConfirmOff(false)}>
                                        Keep it on
                                    </Button>
                                </div>
                            </div>
                        )}
                        <details className="text-xs">
                            <summary className="text-text-secondary cursor-pointer">
                                {egress.data.recommended.entries.length} hosts, read only
                            </summary>
                            <ul className="mt-2 flex flex-col gap-1">
                                {egress.data.recommended.entries.map((e) => (
                                    <li key={e.host}>
                                        <span className="font-mono">{e.host}</span>{" "}
                                        <span className="text-text-tertiary">
                                            {e.paths.join(", ")} · {e.why}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </details>
                    </div>

                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium">Who may add a host to an environment</span>
                        <Select value={settings.whoMayAdd} disabled={!canChange} onValueChange={(v) => save({ whoMayAdd: v as EgressWhoMayAdd })}>
                            <SelectTrigger className="w-96" aria-label="Who may add a host to an environment">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {(Object.keys(WHO_MAY_ADD_LABEL) as EgressWhoMayAdd[]).map((k) => (
                                    <SelectItem key={k} value={k}>
                                        {WHO_MAY_ADD_LABEL[k]}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium">Org list: every environment gets these</span>
                        <EgressApprovalsList scopeId="*" approvals={egress.data.orgList} canChange={canChange} />
                        {canChange && <AddToOrgList />}
                    </div>

                    {egress.data.audit.length > 0 && (
                        <details className="text-xs">
                            <summary className="text-text-secondary cursor-pointer">Changes ({egress.data.audit.length})</summary>
                            <ul className="mt-2 flex flex-col gap-1">
                                {egress.data.audit.slice(0, 50).map((row, i) => (
                                    <li key={i} className="text-text-tertiary">
                                        {row.action === "settings" ? "Settings changed" : `${row.action === "revoke" ? "Revoked" : "Allowed"} ${row.host ?? ""}`}
                                        {row.environmentId ? ` (${row.environmentId === "*" ? "org list" : row.environmentId})` : ""} by {row.actor} ·{" "}
                                        <RelativeTime at={row.at} />
                                    </li>
                                ))}
                            </ul>
                        </details>
                    )}
                </div>
            )}
        </RuntimeSection>
    );
};
