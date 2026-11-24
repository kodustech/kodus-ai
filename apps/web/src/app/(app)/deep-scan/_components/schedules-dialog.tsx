"use client";

import { useMemo, useState } from "react";
import { Alert, AlertDescription } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { useGetSelectedRepositories } from "@services/codeManagement/hooks";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import {
    removeSecurityScanSchedule,
    saveSecurityScanSchedule,
    securityScanSchedulesPath,
} from "@services/security-scans/fetch";
import {
    useExportDestinations,
    useSecurityScanSchedules,
} from "@services/security-scans/hooks";
import type {
    ScanCadence,
    ScanExportTarget,
    SecurityScanMode,
    SecurityScanSchedule,
} from "@services/security-scans/types";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { CalendarClockIcon, XCircleIcon } from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { usePermissions } from "src/core/providers/permissions.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { extractRejectionMessage } from "src/core/utils/extract-error-message";
import { hasPermission } from "src/core/utils/permission-map";

import { parseScanLimit } from "../../issues/_components/security-scan/format";
import { useScanModels } from "./use-scan-models";

const ROUTING_MODEL = "__routing";
const NO_EXPORT = "__none";

/**
 * "Schedules": a repository's deep scan on a clock, daily or weekly, within
 * a limit per run, incremental by default, its new findings optionally filed
 * in a plugin when each run ends.
 */
export const SchedulesButton = () => {
    const canSchedule = usePermission(Action.Create, ResourceType.SecurityScan);
    const [open, setOpen] = useState(false);
    if (!canSchedule) return null;
    return (
        <>
            <Button
                size="sm"
                variant="secondary"
                leftIcon={<CalendarClockIcon />}
                onClick={() => setOpen(true)}>
                Schedules
            </Button>
            {open && <SchedulesDialog onClose={() => setOpen(false)} />}
        </>
    );
};

const SchedulesDialog = ({ onClose }: { onClose: () => void }) => {
    const { teamId } = useSelectedTeamId();
    const { organizationId } = useAuth();
    const permissions = usePermissions();
    const queryClient = useQueryClient();
    const schedules = useSecurityScanSchedules();
    const scanModels = useScanModels();
    const destinations = useExportDestinations(teamId);
    const { data: allRepositories } = useGetSelectedRepositories(teamId);

    const repositories = useMemo(
        () =>
            !organizationId || !Array.isArray(allRepositories)
                ? []
                : allRepositories.filter((repo) =>
                      hasPermission({
                          permissions,
                          organizationId,
                          action: Action.Create,
                          resource: ResourceType.SecurityScan,
                          repoId: String(repo.id),
                      }),
                  ),
        [allRepositories, organizationId, permissions],
    );
    const nameOf = (id: string) =>
        repositories.find((r) => String(r.id) === id)?.name ?? id;

    const [editing, setEditing] = useState<string | null>(null);
    const [repositoryId, setRepositoryId] = useState("");
    const [cadence, setCadence] = useState<ScanCadence>("weekly");
    const [maxUsd, setMaxUsd] = useState("10");
    const [mode, setMode] = useState<SecurityScanMode>("incremental");
    const [modelId, setModelId] = useState(ROUTING_MODEL);
    const [exportTo, setExportTo] = useState(NO_EXPORT);
    const [note, setNote] = useState("");
    const [minSeverity, setMinSeverity] =
        useState<ScanExportTarget["minSeverity"]>("high");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string>();

    const { value: limit, error: limitError } = parseScanLimit(
        maxUsd.trim(),
        "usd",
    );

    const edit = (s: SecurityScanSchedule) => {
        setEditing(s.repository.id);
        setRepositoryId(s.repository.id);
        setCadence(s.cadence);
        setMaxUsd(s.budget.maxUsd !== undefined ? String(s.budget.maxUsd) : "");
        setMode(s.mode);
        setModelId(s.modelId ?? ROUTING_MODEL);
        setExportTo(s.exportTo?.integrationId ?? NO_EXPORT);
        setNote(s.exportTo?.destinationNote ?? "");
        setMinSeverity(s.exportTo?.minSeverity ?? "high");
        setError(undefined);
    };

    const refresh = () =>
        queryClient.invalidateQueries({
            queryKey: [securityScanSchedulesPath()],
        });

    const save = async () => {
        if (!teamId || !repositoryId || limit === undefined || limitError)
            return;
        setSaving(true);
        setError(undefined);
        try {
            await saveSecurityScanSchedule({
                teamId,
                repositoryId,
                cadence,
                maxUsd: limit,
                mode,
                ...(modelId === ROUTING_MODEL ? {} : { modelId }),
                ...(exportTo === NO_EXPORT
                    ? {}
                    : {
                          exportTo: {
                              integrationId: exportTo,
                              minSeverity,
                              ...(note.trim()
                                  ? { destinationNote: note.trim() }
                                  : {}),
                          },
                      }),
            });
            await refresh();
            setEditing(null);
            setRepositoryId("");
        } catch (e) {
            setError(
                extractRejectionMessage(e) ??
                    "We couldn't save the schedule. Try again.",
            );
        } finally {
            setSaving(false);
        }
    };

    const remove = async (id: string) => {
        if (!teamId) return;
        try {
            await removeSecurityScanSchedule(teamId, id);
            await refresh();
        } catch (e) {
            setError(
                extractRejectionMessage(e) ??
                    "We couldn't remove the schedule. Try again.",
            );
        }
    };

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Deep scan schedules</DialogTitle>
                    <DialogDescription>
                        A repository scanned on a clock, at 03:00 UTC, within a
                        limit per run. Incremental runs read only what changed
                        since the last one, so a weekly run usually costs a
                        fraction of the first.
                    </DialogDescription>
                </DialogHeader>

                {schedules.data.length > 0 && (
                    <ul className="divide-card-lv3/60 border-card-lv3/60 divide-y rounded-lg border text-sm">
                        {schedules.data.map((s) => (
                            <li
                                key={s.uuid}
                                className="flex items-center justify-between gap-3 px-3 py-2">
                                <span className="flex min-w-0 flex-col">
                                    <span className="text-text-primary truncate">
                                        {nameOf(s.repository.id)} · {s.cadence}{" "}
                                        · up to ${s.budget.maxUsd ?? "—"} ·{" "}
                                        {s.mode === "full"
                                            ? "whole repository"
                                            : "what changed"}
                                        {s.modelId &&
                                            ` · ${scanModels.nameOf(s.modelId) ?? "picked model"}`}
                                    </span>
                                    <span className="text-text-tertiary truncate text-xs">
                                        {s.enabled
                                            ? `Next ${formatDistanceToNow(
                                                  new Date(s.nextRunAt),
                                                  { addSuffix: true },
                                              )}`
                                            : "Paused"}
                                        {s.exportTo &&
                                            ` · files ${s.exportTo.minSeverity}+ in ${destinations.data.find((d) => d.integrationId === s.exportTo?.integrationId)?.name ?? "a plugin"}`}
                                        {s.lastError && (
                                            <span className="text-danger">
                                                {" "}
                                                · {s.lastError}
                                            </span>
                                        )}
                                    </span>
                                </span>
                                <span className="flex shrink-0 gap-2">
                                    <Button
                                        size="xs"
                                        variant="helper"
                                        onClick={() => edit(s)}>
                                        Edit
                                    </Button>
                                    <Button
                                        size="xs"
                                        variant="helper"
                                        onClick={() => remove(s.repository.id)}>
                                        Remove
                                    </Button>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}

                <form
                    id="save-scan-schedule"
                    className="grid grid-cols-1 gap-4 md:grid-cols-2"
                    onSubmit={(ev) => {
                        ev.preventDefault();
                        save();
                    }}>
                    <FormControl.Root>
                        <FormControl.Label htmlFor="schedule-repository">
                            Repository
                        </FormControl.Label>
                        <FormControl.Input>
                            <Select
                                value={repositoryId}
                                disabled={saving || !!editing}
                                onValueChange={setRepositoryId}>
                                <SelectTrigger
                                    id="schedule-repository"
                                    size="md">
                                    <SelectValue placeholder="Choose a repository" />
                                </SelectTrigger>
                                <SelectContent>
                                    {repositories.map((repo) => (
                                        <SelectItem
                                            key={repo.id}
                                            value={String(repo.id)}>
                                            {repo.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </FormControl.Input>
                    </FormControl.Root>

                    <FormControl.Root>
                        <FormControl.Label htmlFor="schedule-cadence">
                            Every
                        </FormControl.Label>
                        <FormControl.Input>
                            <Select
                                value={cadence}
                                disabled={saving}
                                onValueChange={(v) =>
                                    setCadence(v as ScanCadence)
                                }>
                                <SelectTrigger id="schedule-cadence" size="md">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="daily">Day</SelectItem>
                                    <SelectItem value="weekly">Week</SelectItem>
                                </SelectContent>
                            </Select>
                        </FormControl.Input>
                    </FormControl.Root>

                    <FormControl.Root>
                        <FormControl.Label htmlFor="schedule-limit">
                            Limit per run (USD)
                        </FormControl.Label>
                        <FormControl.Input>
                            <Input
                                id="schedule-limit"
                                size="md"
                                inputMode="decimal"
                                value={maxUsd}
                                error={limitError}
                                disabled={saving}
                                onChange={(ev) => setMaxUsd(ev.target.value)}
                            />
                        </FormControl.Input>
                        {limitError && (
                            <FormControl.Error>{limitError}</FormControl.Error>
                        )}
                    </FormControl.Root>

                    <FormControl.Root>
                        <FormControl.Label htmlFor="schedule-mode">
                            What to read
                        </FormControl.Label>
                        <FormControl.Input>
                            <Select
                                value={mode}
                                disabled={saving}
                                onValueChange={(v) =>
                                    setMode(v as SecurityScanMode)
                                }>
                                <SelectTrigger id="schedule-mode" size="md">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="incremental">
                                        What changed
                                    </SelectItem>
                                    <SelectItem value="full">
                                        The whole repository
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </FormControl.Input>
                    </FormControl.Root>

                    <FormControl.Root>
                        <FormControl.Label htmlFor="schedule-model">
                            Model
                        </FormControl.Label>
                        <FormControl.Input>
                            <Select
                                value={modelId}
                                disabled={saving}
                                onValueChange={setModelId}>
                                <SelectTrigger id="schedule-model" size="md">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={ROUTING_MODEL}>
                                        Deep scan routing
                                    </SelectItem>
                                    {scanModels.models.map((m) => (
                                        <SelectItem key={m.id} value={m.id}>
                                            {m.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </FormControl.Input>
                    </FormControl.Root>

                    <FormControl.Root>
                        <FormControl.Label htmlFor="schedule-export">
                            File new findings in
                        </FormControl.Label>
                        <FormControl.Input>
                            <Select
                                value={exportTo}
                                disabled={saving}
                                onValueChange={setExportTo}>
                                <SelectTrigger id="schedule-export" size="md">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={NO_EXPORT}>
                                        Nowhere
                                    </SelectItem>
                                    {destinations.data.map((d) => (
                                        <SelectItem
                                            key={d.integrationId}
                                            value={d.integrationId}>
                                            {d.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </FormControl.Input>
                    </FormControl.Root>

                    {exportTo !== NO_EXPORT && (
                        <>
                            <FormControl.Root>
                                <FormControl.Label htmlFor="schedule-min-severity">
                                    From severity
                                </FormControl.Label>
                                <FormControl.Input>
                                    <Select
                                        value={minSeverity}
                                        disabled={saving}
                                        onValueChange={(v) =>
                                            setMinSeverity(
                                                v as ScanExportTarget["minSeverity"],
                                            )
                                        }>
                                        <SelectTrigger
                                            id="schedule-min-severity"
                                            size="md">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="critical">
                                                Critical
                                            </SelectItem>
                                            <SelectItem value="high">
                                                High and up
                                            </SelectItem>
                                            <SelectItem value="medium">
                                                Medium and up
                                            </SelectItem>
                                            <SelectItem value="low">
                                                Everything
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                </FormControl.Input>
                            </FormControl.Root>
                            <FormControl.Root>
                                <FormControl.Label htmlFor="schedule-note">
                                    Where in it (optional)
                                </FormControl.Label>
                                <FormControl.Input>
                                    <Input
                                        id="schedule-note"
                                        size="md"
                                        placeholder='e.g. "team SEC"'
                                        value={note}
                                        maxLength={300}
                                        disabled={saving}
                                        onChange={(ev) =>
                                            setNote(ev.target.value)
                                        }
                                    />
                                </FormControl.Input>
                            </FormControl.Root>
                        </>
                    )}
                </form>

                {error && (
                    <Alert variant="danger">
                        <XCircleIcon />
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}

                <DialogFooter>
                    <Button size="md" variant="cancel" onClick={onClose}>
                        Close
                    </Button>
                    <Button
                        size="md"
                        variant="primary"
                        type="submit"
                        form="save-scan-schedule"
                        leftIcon={<CalendarClockIcon />}
                        loading={saving}
                        disabled={
                            !repositoryId ||
                            limit === undefined ||
                            !!limitError ||
                            saving
                        }>
                        {editing ? "Save schedule" : "Add schedule"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
