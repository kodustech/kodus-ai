"use client";

import { useState } from "react";
import { Switch } from "@components/ui/switch";
import { RuntimeSection } from "@components/runtime/section";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { Skeleton } from "@components/ui/skeleton";
import { toast } from "@components/ui/toaster/use-toast";
import type { SandboxCapacityView } from "@services/runtime/contracts";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    capacityWarning,
    CELL_HOST_HINT,
    formatWait,
    parseMaxConcurrent,
    sizeLabel,
    WAIT_CHOICES_MINUTES,
    waitLabel,
} from "@services/runtime/model/sandbox-capacity";
import {
    useSandboxCapacity,
    useUpdateSandboxCapacity,
} from "@services/runtime/queries";

// Kody Runtime -> Settings -> Sandboxes (docs/runtime/self-hosted.md, "Sizing
// sandbox capacity"): the deployment's cap on sandboxes held at once and how
// long a review waits in line. Self-hosted owners only.

const Stat = ({ label, value, caption }: { label: string; value: string; caption?: string }) => (
    <div className="flex flex-col">
        <span className="text-text-tertiary text-xs">{label}</span>
        <span className="text-text-primary text-lg font-semibold tabular-nums">{value}</span>
        {caption && <span className="text-text-tertiary text-xs">{caption}</span>}
    </div>
);

const Fact = ({ label, value }: { label: string; value: string }) => (
    <div className="flex flex-col gap-0.5">
        <dt className="text-text-tertiary text-xs">{label}</dt>
        <dd className="text-text-primary text-sm">{value}</dd>
    </div>
);

export const SandboxLiveBar = ({ live }: { live: SandboxCapacityView["live"] }) => {
    const capped = live.cap > 0;
    const inUse = live.inUse ?? 0;
    const ratio = capped ? Math.min(1, inUse / live.cap) : 0;
    const full = capped && inUse >= live.cap;
    const tone = full ? "bg-danger" : ratio >= 0.8 ? "bg-warning" : "bg-primary-light";
    return (
        <div role="group" aria-label="Live usage" className="bg-card-lv2 flex flex-col gap-3 rounded-lg p-4">
            <div className="flex flex-wrap gap-x-10 gap-y-2">
                <Stat
                    label="In use"
                    value={capped ? `${inUse} of ${live.cap}` : String(inUse)}
                    caption={capped ? (full ? "At the limit" : undefined) : "No limit set"}
                />
                <Stat label="Queued" value={String(live.queued)} caption={live.queued === 0 ? "Nobody is waiting" : undefined} />
                {live.queued > 0 && <Stat label="Oldest wait" value={formatWait(live.oldestWaitMs)} />}
            </div>
            {capped && (
                <div className="flex flex-col gap-1">
                    <div
                        role="progressbar"
                        aria-label="Sandboxes in use"
                        aria-valuemin={0}
                        aria-valuemax={live.cap}
                        aria-valuenow={inUse}
                        aria-valuetext={`${inUse} of ${live.cap} sandboxes in use`}
                        className="bg-card-lv3 h-2 w-full overflow-hidden rounded-full">
                        <div className={`${tone} h-full transition-all`} style={{ width: `${Math.round(ratio * 100)}%` }} />
                    </div>
                    <div className="text-text-tertiary flex justify-between text-xs tabular-nums">
                        <span>0</span>
                        <span>{live.cap}</span>
                    </div>
                </div>
            )}
        </div>
    );
};

const CAP_NOTE_ID = "sandbox-cap-note";
const CAP_ALERT_ID = "sandbox-cap-alert";

export const SandboxCapacityForm = ({ view }: { view: SandboxCapacityView }) => {
    const savedCap = view.settings.maxConcurrent === null ? "" : String(view.settings.maxConcurrent);
    const savedWait = Math.round(view.settings.maxWaitMs / 60_000);
    const [limited, setLimited] = useState(view.settings.maxConcurrent !== null);
    const [capText, setCapText] = useState(savedCap);
    const [waitMinutes, setWaitMinutes] = useState(savedWait);
    const update = useUpdateSandboxCapacity();
    const emptyWhileLimited = limited && capText.trim() === "";
    const parsed = limited ? parseMaxConcurrent(capText) : ({ ok: true, value: null } as const);
    const effectiveCap = limited ? capText : "";
    const dirty = effectiveCap !== savedCap || waitMinutes !== savedWait;
    const valid = parsed.ok && !emptyWhileLimited;
    const warning = parsed.ok ? capacityWarning(parsed.value, view.cell) : null;
    const fieldError = emptyWhileLimited
        ? `Enter a whole number from 1 to 100, or turn the limit off.`
        : !parsed.ok
          ? parsed.error
          : null;
    const choices = [...new Set([...WAIT_CHOICES_MINUTES, waitMinutes])].sort((a, b) => a - b);
    const cell = view.cell;
    const describedBy = [CAP_NOTE_ID, fieldError ? CAP_ALERT_ID : warning ? CAP_ALERT_ID : null]
        .filter(Boolean)
        .join(" ");

    const discard = () => {
        setLimited(view.settings.maxConcurrent !== null);
        setCapText(savedCap);
        setWaitMinutes(savedWait);
    };

    return (
        <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
                event.preventDefault();
                if (!valid || !dirty || !parsed.ok) return;
                update.mutate(
                    { maxConcurrent: parsed.value, maxWaitMs: waitMinutes * 60_000 },
                    {
                        onSuccess: () =>
                            toast({
                                variant: "success",
                                title: "Sandbox capacity saved",
                                description: "Every worker picks it up within seconds.",
                            }),
                        onError: (error) =>
                            toast({
                                variant: "danger",
                                title: "Couldn't save the sandbox capacity",
                                description: runtimeErrorMessage(error, {
                                    fallback: "Try again in a moment.",
                                    403: "Only the owner of the organization can change it.",
                                }),
                            }),
                    },
                );
            }}>
            <SandboxLiveBar live={view.live} />

            <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-3">
                        <Label htmlFor="sandbox-limit-switch" className="text-text-primary text-sm">
                            Limit sandboxes at the same time
                        </Label>
                        <Switch
                            id="sandbox-limit-switch"
                            size="sm"
                            checked={limited}
                            disabled={update.isPending}
                            onCheckedChange={(on) => {
                                setLimited(on);
                                if (on && capText.trim() === "") {
                                    setCapText(String(view.suggestedMaxConcurrent ?? ""));
                                }
                            }}
                        />
                    </div>
                    {limited ? (
                        <div className="w-40">
                            <Input
                                type="number"
                                min={1}
                                max={100}
                                step={1}
                                inputMode="numeric"
                                aria-label="Maximum at the same time"
                                aria-invalid={!!fieldError}
                                aria-describedby={describedBy}
                                placeholder="e.g. 5"
                                value={capText}
                                disabled={update.isPending}
                                onChange={(e) => setCapText(e.target.value)}
                            />
                        </div>
                    ) : (
                        <p className="text-text-secondary text-sm">No limit: every review gets a sandbox at once.</p>
                    )}
                    <span id={CAP_NOTE_ID} className="text-text-tertiary text-xs">
                        {view.suggestedMaxConcurrent !== null
                            ? `Suggested: ${view.suggestedMaxConcurrent}, from the cell's memory.`
                            : "No suggestion: this deployment does not report the cell's memory."}
                    </span>
                    {fieldError ? (
                        <p id={CAP_ALERT_ID} className="text-danger text-sm" role="alert">
                            {fieldError}
                        </p>
                    ) : warning ? (
                        <p id={CAP_ALERT_ID} className="text-warning text-sm" role="alert">
                            {warning}
                        </p>
                    ) : null}
                </div>

                <div className="flex flex-col gap-1.5">
                    <Label className="text-text-primary text-sm">Longest wait in line</Label>
                    <div className="w-40">
                        <Select
                            value={String(waitMinutes)}
                            onValueChange={(v) => setWaitMinutes(Number(v))}
                            disabled={update.isPending}>
                            <SelectTrigger aria-label="Longest wait in line">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {choices.map((m) => (
                                    <SelectItem key={m} value={String(m)}>
                                        {waitLabel(m)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <span className="text-text-tertiary text-xs">
                        Past it, the review runs without a sandbox and says so.
                    </span>
                </div>
            </div>

            <div className="bg-card-lv2 flex flex-col gap-3 rounded-lg p-4">
                <span className="text-text-secondary text-xs font-medium">Set on the cell host</span>
                <dl className="grid gap-4 sm:grid-cols-2">
                    <Fact
                        label="Size of each"
                        value={cell?.sandboxMemoryMb ? sizeLabel(cell.sandboxMemoryMb, cell.sandboxCpus) : "unknown"}
                    />
                    <Fact
                        label="Ready in the pool"
                        value={
                            cell?.poolReady == null
                                ? "unknown"
                                : cell.poolTarget != null
                                  ? `${cell.poolReady} of ${cell.poolTarget}`
                                  : String(cell.poolReady)
                        }
                    />
                </dl>
                <span className="text-text-tertiary text-xs">{CELL_HOST_HINT}</span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
                <Button
                    type="submit"
                    size="md"
                    variant="primary"
                    disabled={!dirty || !valid || update.isPending}
                    loading={update.isPending}>
                    Save
                </Button>
                {dirty && !update.isPending && (
                    <Button type="button" size="md" variant="cancel" onClick={discard}>
                        Discard
                    </Button>
                )}
                <span className="text-text-tertiary text-xs" role="status">
                    {update.isPending ? "Saving..." : dirty ? "Unsaved changes" : update.isSuccess ? "Saved" : ""}
                </span>
            </div>
        </form>
    );
};

const CapacitySkeleton = () => (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading sandbox capacity">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-20 w-full" />
    </div>
);

/** The owner's sandbox section of the Runtime settings page (self-hosted only). */
export const SandboxCapacitySection = () => {
    const view = useSandboxCapacity();
    return (
        <RuntimeSection
            id="sandboxes"
            title="Sandboxes"
            description="How many review sandboxes this installation holds at once, and how long a review waits in line for one. No deploy needed to change it.">
            {view.isLoading ? (
                <CapacitySkeleton />
            ) : view.isError || !view.data ? (
                <div className="flex flex-wrap items-center gap-3" role="alert">
                    <p className="text-text-secondary text-sm">
                        Sandbox capacity is not available right now. Try again in a moment.
                    </p>
                    <Button type="button" size="sm" variant="secondary" onClick={() => view.refetch?.()}>
                        Retry
                    </Button>
                </div>
            ) : (
                <SandboxCapacityForm
                    key={JSON.stringify(view.data.settings)}
                    view={view.data}
                />
            )}
        </RuntimeSection>
    );
};
