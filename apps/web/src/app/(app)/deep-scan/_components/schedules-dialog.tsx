"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "@components/ui/alert";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@components/ui/dropdown-menu";
import { Input } from "@components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@components/ui/sheet";
import { Switch } from "@components/ui/switch";
import { nextRunAt } from "@libs/security-scan/domain/scan-schedule";
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
    SaveScanSchedulePayload,
    ScanCadence,
    ScanExportTarget,
    SecurityScanMode,
    SecurityScanSchedule,
} from "@services/security-scans/types";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
    CalendarClockIcon,
    MoreHorizontalIcon,
    PlusIcon,
    XCircleIcon,
} from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { usePermissions } from "src/core/providers/permissions.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { cn } from "src/core/utils/components";
import { extractRejectionMessage } from "src/core/utils/extract-error-message";
import { hasPermission } from "src/core/utils/permission-map";

import { parseScanLimit } from "../../issues/_components/security-scan/format";
import { useScanModels } from "./use-scan-models";

const ROUTING_MODEL = "__routing";
const NO_EXPORT = "__none";

const CADENCE: Record<ScanCadence, string> = { daily: "day", weekly: "week" };
const MODE: Record<SecurityScanMode, string> = {
    incremental: "what changed",
    full: "the whole repository",
};
const SEVERITY_FROM: Record<ScanExportTarget["minSeverity"], string> = {
    critical: "rated critical",
    high: "rated high or above",
    medium: "rated medium or above",
    low: "of any severity",
};

const UTC_WHEN = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
});
const whenUtc = (date: Date) => `${UTC_WHEN.format(date)} UTC`;

/** A schedule saved again as it is, paused or resumed. */
const payloadOf = (
    s: SecurityScanSchedule,
    enabled: boolean,
): SaveScanSchedulePayload => ({
    teamId: s.teamId,
    repositoryId: s.repository.id,
    cadence: s.cadence,
    mode: s.mode,
    ...(s.budget.maxUsd !== undefined ? { maxUsd: s.budget.maxUsd } : {}),
    ...(s.budget.maxTokens !== undefined
        ? { maxTokens: s.budget.maxTokens }
        : {}),
    ...(s.modelId ? { modelId: s.modelId } : {}),
    ...(s.exportTo ? { exportTo: s.exportTo } : {}),
    enabled,
});

/**
 * "Schedules": a repository's deep scan on a clock. Each schedule reads as
 * one sentence, with a switch to pause it; a new one is written the same
 * way, and says when it first runs and where each run stops before saving.
 */
export const SchedulesButton = () => {
    const canSchedule = usePermission(Action.Create, ResourceType.SecurityScan);
    const [open, setOpen] = useState(false);
    if (!canSchedule) return null;
    return (
        <>
            <Button
                size="sm"
                variant="helper"
                leftIcon={<CalendarClockIcon />}
                onClick={() => setOpen(true)}>
                Schedules
            </Button>
            <Sheet open={open} onOpenChange={setOpen}>
                <SheetContent className="w-full gap-0 py-0 sm:max-w-xl">
                    {open && <SchedulesPanel />}
                </SheetContent>
            </Sheet>
        </>
    );
};

type Composing = { repositoryId?: string; schedule?: SecurityScanSchedule };

const SchedulesPanel = () => {
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
    const destinationOf = (id?: string) =>
        destinations.data.find((d) => d.integrationId === id)?.name ??
        "a plugin no longer connected";

    const [composing, setComposing] = useState<Composing | null>(null);
    const [busy, setBusy] = useState<string>();
    const [error, setError] = useState<string>();

    const refresh = () =>
        queryClient.invalidateQueries({
            queryKey: [securityScanSchedulesPath()],
        });

    const toggle = async (s: SecurityScanSchedule, enabled: boolean) => {
        setBusy(s.uuid);
        setError(undefined);
        try {
            await saveSecurityScanSchedule(payloadOf(s, enabled));
            await refresh();
        } catch (e) {
            setError(
                extractRejectionMessage(e) ??
                    "We couldn't update the schedule. Try again.",
            );
        } finally {
            setBusy(undefined);
        }
    };

    const remove = async (s: SecurityScanSchedule) => {
        setBusy(s.uuid);
        setError(undefined);
        try {
            await removeSecurityScanSchedule(s.teamId, s.repository.id);
            await refresh();
        } catch (e) {
            setError(
                extractRejectionMessage(e) ??
                    "We couldn't remove the schedule. Try again.",
            );
        } finally {
            setBusy(undefined);
        }
    };

    const empty = !schedules.isLoading && schedules.data.length === 0;
    const showComposer = composing !== null || empty;

    return (
        <>
            <SheetHeader className="border-card-lv3/60 flex-row items-start justify-between gap-4 border-b px-6 pt-5 pb-4">
                <div className="space-y-1.5">
                    <SheetTitle>Scheduled scans</SheetTitle>
                    <SheetDescription>
                        A repository scanned on a clock, at 03:00 UTC. Each run
                        stops at its limit and, by default, reads only what
                        changed since the last one.
                    </SheetDescription>
                </div>
                {!showComposer && (
                    <Button
                        size="sm"
                        variant="primary"
                        leftIcon={<PlusIcon />}
                        className="mr-8 shrink-0"
                        onClick={() => {
                            setError(undefined);
                            setComposing({});
                        }}>
                        New schedule
                    </Button>
                )}
            </SheetHeader>

            <div className="min-h-0 flex-1 overflow-y-auto">
                {showComposer && (
                    <div className="border-card-lv3/60 border-b px-6 py-5">
                        <Composer
                            key={composing?.schedule?.uuid ?? "new"}
                            teamId={teamId}
                            repositories={repositories}
                            schedule={composing?.schedule}
                            models={scanModels.models}
                            destinations={destinations.data}
                            canCancel={!empty}
                            onCancel={() => setComposing(null)}
                            onSaved={async () => {
                                await refresh();
                                setComposing(null);
                            }}
                        />
                    </div>
                )}

                {error && (
                    <Alert variant="danger" className="mx-6 mt-4">
                        <XCircleIcon />
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}

                {schedules.data.length > 0 && (
                    <ul className="divide-card-lv3/60 divide-y">
                        {schedules.data.map((s) => (
                            <ScheduleRow
                                key={s.uuid}
                                schedule={s}
                                name={nameOf(s.repository.id)}
                                model={
                                    s.modelId
                                        ? (scanModels.nameOf(s.modelId) ??
                                          "a picked model")
                                        : undefined
                                }
                                destination={destinationOf(
                                    s.exportTo?.integrationId,
                                )}
                                busy={busy === s.uuid}
                                editing={composing?.schedule?.uuid === s.uuid}
                                onToggle={(on) => toggle(s, on)}
                                onEdit={() => {
                                    setError(undefined);
                                    setComposing({ schedule: s });
                                }}
                                onRemove={() => remove(s)}
                            />
                        ))}
                    </ul>
                )}
            </div>
        </>
    );
};

const ScheduleRow = ({
    schedule: s,
    name,
    model,
    destination,
    busy,
    editing,
    onToggle,
    onEdit,
    onRemove,
}: {
    schedule: SecurityScanSchedule;
    name: string;
    model?: string;
    destination: string;
    busy: boolean;
    editing: boolean;
    onToggle: (enabled: boolean) => void;
    onEdit: () => void;
    onRemove: () => void;
}) => {
    const next = new Date(s.nextRunAt);
    const limit =
        s.budget.maxUsd !== undefined
            ? `up to $${s.budget.maxUsd}`
            : s.budget.maxTokens !== undefined
              ? `up to ${s.budget.maxTokens.toLocaleString()} tokens`
              : "no limit";

    return (
        <li
            className={cn(
                "flex items-start gap-4 px-6 py-4",
                editing && "bg-card-lv2/50",
                !s.enabled && "opacity-70",
            )}>
            <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                    <span className="text-text-primary truncate text-sm font-semibold">
                        {name}
                    </span>
                    {!s.enabled && (
                        <Badge variant="helper" className="shrink-0">
                            Paused
                        </Badge>
                    )}
                </div>
                <p className="text-text-secondary text-sm">
                    Every {CADENCE[s.cadence]}, reads {MODE[s.mode]}, {limit}
                    {model && ` on ${model}`}.
                </p>
                <p className="text-text-tertiary text-xs">
                    {s.enabled
                        ? `Next ${whenUtc(next)} · ${formatDistanceToNow(next, { addSuffix: true })}`
                        : "No run until it is turned back on"}
                    {s.exportTo &&
                        ` · files new findings ${SEVERITY_FROM[s.exportTo.minSeverity]} in ${destination}`}
                </p>
                {s.lastError && (
                    <p className="text-danger text-xs">
                        Last run: {s.lastError}
                    </p>
                )}
            </div>

            <div className="flex shrink-0 items-center gap-1">
                <Switch
                    size="sm"
                    checked={s.enabled}
                    loading={busy}
                    disabled={busy}
                    aria-label={
                        s.enabled ? "Pause schedule" : "Resume schedule"
                    }
                    onCheckedChange={onToggle}
                />
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            size="icon-sm"
                            variant="cancel"
                            aria-label={`Actions for ${name}`}>
                            <MoreHorizontalIcon />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={onEdit}>
                            Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            className="text-danger"
                            onSelect={onRemove}>
                            Remove
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </li>
    );
};

/** A select that sits inside a sentence: as wide as its value. */
const Slot = ({
    label,
    value,
    onChange,
    disabled,
    placeholder,
    children,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    placeholder?: string;
    children: ReactNode;
}) => (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger
            size="sm"
            aria-label={label}
            className="text-text-primary inline-flex w-auto max-w-64 gap-1.5 px-3 font-medium">
            <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
    </Select>
);

const Composer = ({
    teamId,
    repositories,
    schedule,
    models,
    destinations,
    canCancel,
    onCancel,
    onSaved,
}: {
    teamId?: string;
    repositories: Array<{ id: string | number; name: string }>;
    schedule?: SecurityScanSchedule;
    models: Array<{ id: string; label: string }>;
    destinations: Array<{ integrationId: string; name: string }>;
    canCancel: boolean;
    onCancel: () => void;
    onSaved: () => Promise<void>;
}) => {
    const [repositoryId, setRepositoryId] = useState(
        schedule?.repository.id ?? "",
    );
    const [cadence, setCadence] = useState<ScanCadence>(
        schedule?.cadence ?? "weekly",
    );
    const [maxUsd, setMaxUsd] = useState(
        schedule?.budget.maxUsd !== undefined
            ? String(schedule.budget.maxUsd)
            : schedule
              ? ""
              : "10",
    );
    const [mode, setMode] = useState<SecurityScanMode>(
        schedule?.mode ?? "incremental",
    );
    const [modelId, setModelId] = useState(schedule?.modelId ?? ROUTING_MODEL);
    const [exportTo, setExportTo] = useState(
        schedule?.exportTo?.integrationId ?? NO_EXPORT,
    );
    const [minSeverity, setMinSeverity] = useState<
        ScanExportTarget["minSeverity"]
    >(schedule?.exportTo?.minSeverity ?? "high");
    const [note, setNote] = useState(schedule?.exportTo?.destinationNote ?? "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string>();

    const { value: limit, error: limitError } = parseScanLimit(
        maxUsd.trim(),
        "usd",
    );
    const firstRun = nextRunAt(cadence, new Date());
    const owner = schedule?.teamId ?? teamId;
    const ready =
        !!owner && !!repositoryId && limit !== undefined && !limitError;

    const save = async () => {
        if (!ready || !owner || limit === undefined) return;
        setSaving(true);
        setError(undefined);
        try {
            await saveSecurityScanSchedule({
                teamId: owner,
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
            await onSaved();
        } catch (e) {
            setError(
                extractRejectionMessage(e) ??
                    "We couldn't save the schedule. Try again.",
            );
        } finally {
            setSaving(false);
        }
    };

    const line =
        "text-text-secondary flex flex-wrap items-center gap-x-2 gap-y-2 text-sm leading-8";

    return (
        <form
            className="space-y-2"
            onSubmit={(ev) => {
                ev.preventDefault();
                save();
            }}>
            <p className="text-text-tertiary text-xs font-medium tracking-wide uppercase">
                {schedule ? "Edit schedule" : "New schedule"}
            </p>

            <div className={line}>
                <span>Scan</span>
                <Slot
                    label="Repository"
                    value={repositoryId}
                    disabled={saving || !!schedule}
                    placeholder="a repository"
                    onChange={setRepositoryId}>
                    {repositories.map((repo) => (
                        <SelectItem key={repo.id} value={String(repo.id)}>
                            {repo.name}
                        </SelectItem>
                    ))}
                </Slot>
                <span>every</span>
                <Slot
                    label="Cadence"
                    value={cadence}
                    disabled={saving}
                    onChange={(v) => setCadence(v as ScanCadence)}>
                    <SelectItem value="daily">day</SelectItem>
                    <SelectItem value="weekly">week</SelectItem>
                </Slot>
                <span>reading</span>
                <Slot
                    label="What to read"
                    value={mode}
                    disabled={saving}
                    onChange={(v) => setMode(v as SecurityScanMode)}>
                    <SelectItem value="incremental">what changed</SelectItem>
                    <SelectItem value="full">the whole repository</SelectItem>
                </Slot>
            </div>

            <div className={line}>
                <span>Stop each run at</span>
                <span className="inline-block w-24">
                    <Input
                        size="md"
                        aria-label="Limit per run in USD"
                        inputMode="decimal"
                        value={maxUsd}
                        error={limitError}
                        disabled={saving}
                        leftIcon={<span className="text-sm">$</span>}
                        className="h-8 pr-3 pl-8"
                        onChange={(ev) => setMaxUsd(ev.target.value)}
                    />
                </span>
                <span>on</span>
                <Slot
                    label="Model"
                    value={modelId}
                    disabled={saving}
                    onChange={setModelId}>
                    <SelectItem value={ROUTING_MODEL}>
                        the Deep scan routing
                    </SelectItem>
                    {models.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                            {m.label}
                        </SelectItem>
                    ))}
                </Slot>
            </div>

            <div className={line}>
                <span>File new findings</span>
                {exportTo !== NO_EXPORT && (
                    <Slot
                        label="Lowest severity to file"
                        value={minSeverity}
                        disabled={saving}
                        onChange={(v) =>
                            setMinSeverity(v as ScanExportTarget["minSeverity"])
                        }>
                        {(
                            Object.keys(SEVERITY_FROM) as Array<
                                ScanExportTarget["minSeverity"]
                            >
                        ).map((severity) => (
                            <SelectItem key={severity} value={severity}>
                                {SEVERITY_FROM[severity]}
                            </SelectItem>
                        ))}
                    </Slot>
                )}
                <span>in</span>
                <Slot
                    label="Plugin to file findings in"
                    value={exportTo}
                    disabled={saving}
                    onChange={setExportTo}>
                    <SelectItem value={NO_EXPORT}>nowhere</SelectItem>
                    {destinations.map((d) => (
                        <SelectItem
                            key={d.integrationId}
                            value={d.integrationId}>
                            {d.name}
                        </SelectItem>
                    ))}
                    {exportTo !== NO_EXPORT &&
                        !destinations.some(
                            (d) => d.integrationId === exportTo,
                        ) && (
                            <SelectItem value={exportTo}>
                                a plugin no longer connected
                            </SelectItem>
                        )}
                </Slot>
                {exportTo !== NO_EXPORT && (
                    <span className="inline-block w-40">
                        <Input
                            size="md"
                            aria-label="Where in that plugin (optional)"
                            placeholder="where: team SEC"
                            value={note}
                            maxLength={300}
                            disabled={saving}
                            className="h-8 px-3"
                            onChange={(ev) => setNote(ev.target.value)}
                        />
                    </span>
                )}
            </div>

            {limitError && <p className="text-danger text-xs">{limitError}</p>}
            {error && (
                <Alert variant="danger">
                    <XCircleIcon />
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}

            <div className="border-card-lv3/60 mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <p className="text-text-tertiary min-w-0 flex-1 text-xs">
                    {ready
                        ? `${schedule ? "Next" : "First"} scan ${whenUtc(firstRun)}. Each run stops at $${limit}${
                              mode === "incremental"
                                  ? " and reads only files changed since the last."
                                  : " and reads the whole repository."
                          }`
                        : "Pick a repository and a limit to see when it first runs."}
                </p>
                <div className="flex shrink-0 gap-2">
                    {canCancel && (
                        <Button
                            size="sm"
                            variant="cancel"
                            disabled={saving}
                            onClick={onCancel}>
                            Cancel
                        </Button>
                    )}
                    <Button
                        size="sm"
                        variant="primary"
                        type="submit"
                        loading={saving}
                        disabled={!ready || saving}>
                        {schedule ? "Save changes" : "Add schedule"}
                    </Button>
                </div>
            </div>
        </form>
    );
};
