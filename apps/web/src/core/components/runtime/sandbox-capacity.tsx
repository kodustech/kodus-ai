"use client";

import { useState } from "react";
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

const Stat = ({ label, value }: { label: string; value: string }) => (
    <div className="flex flex-col">
        <span className="text-text-tertiary text-xs">{label}</span>
        <span className="text-text-primary text-lg font-semibold tabular-nums">
            {value}
        </span>
    </div>
);

const Fact = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
    <div className="flex flex-col gap-0.5">
        <Label className="text-text-primary text-sm">{label}</Label>
        <span className="text-text-secondary text-sm">{value}</span>
        {hint && <span className="text-text-tertiary text-xs">{hint}</span>}
    </div>
);

export const SandboxLiveBar = ({ live }: { live: SandboxCapacityView["live"] }) => {
    const capped = live.cap > 0;
    const inUse = live.inUse ?? 0;
    const pct = capped ? Math.min(100, Math.round((inUse / live.cap) * 100)) : 0;
    return (
        <div className="bg-card-lv2 flex flex-col gap-3 rounded-lg p-4">
            <div className="flex flex-wrap gap-x-8 gap-y-2">
                <Stat label="In use" value={capped ? `${inUse}/${live.cap}` : "no limit"} />
                <Stat label="Queued" value={String(live.queued)} />
                <Stat label="Wait" value={formatWait(live.oldestWaitMs)} />
            </div>
            {capped && (
                <div
                    role="progressbar"
                    aria-label="Sandboxes in use"
                    aria-valuemin={0}
                    aria-valuemax={live.cap}
                    aria-valuenow={inUse}
                    className="bg-card-lv3 h-2 w-full overflow-hidden rounded-full">
                    <div className="bg-primary-light h-full" style={{ width: `${pct}%` }} />
                </div>
            )}
        </div>
    );
};

export const SandboxCapacityForm = ({ view }: { view: SandboxCapacityView }) => {
    const [capText, setCapText] = useState(
        view.settings.maxConcurrent === null ? "" : String(view.settings.maxConcurrent),
    );
    const [waitMinutes, setWaitMinutes] = useState(Math.round(view.settings.maxWaitMs / 60_000));
    const update = useUpdateSandboxCapacity();
    const parsed = parseMaxConcurrent(capText);
    const dirty =
        capText !== (view.settings.maxConcurrent === null ? "" : String(view.settings.maxConcurrent)) ||
        waitMinutes * 60_000 !== view.settings.maxWaitMs;
    const warning = parsed.ok ? capacityWarning(parsed.value, view.cell) : null;
    const choices = [...new Set([...WAIT_CHOICES_MINUTES, waitMinutes])].sort((a, b) => a - b);
    const cell = view.cell;

    return (
        <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
                event.preventDefault();
                if (!parsed.ok || !dirty) return;
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
            <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                    <Label className="text-text-primary text-sm">Maximum at the same time</Label>
                    <Input
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        inputMode="numeric"
                        aria-label="Maximum at the same time"
                        placeholder="No limit"
                        value={capText}
                        disabled={update.isPending}
                        onChange={(e) => setCapText(e.target.value)}
                    />
                    <span className="text-text-tertiary text-xs">
                        {capText.trim() === "" ? "No limit: every review gets a sandbox at once. " : ""}
                        {view.suggestedMaxConcurrent !== null
                            ? `Suggested: ${view.suggestedMaxConcurrent}.`
                            : "No suggestion: this deployment does not report the cell's memory."}
                    </span>
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label className="text-text-primary text-sm">Longest wait in line</Label>
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
                    <span className="text-text-tertiary text-xs">
                        Past it, the review runs without a sandbox and says so.
                    </span>
                </div>
                <Fact
                    label="Size of each"
                    value={cell?.sandboxMemoryMb ? sizeLabel(cell.sandboxMemoryMb, cell.sandboxCpus) : "unknown"}
                    hint={CELL_HOST_HINT}
                />
                <Fact
                    label="Ready in the pool"
                    value={cell?.poolReady != null ? String(cell.poolReady) : "unknown"}
                    hint={CELL_HOST_HINT}
                />
            </div>
            {warning && (
                <p className="text-warning text-sm" role="alert">
                    {warning}
                </p>
            )}
            {!parsed.ok && (
                <p className="text-danger text-sm" role="alert">
                    {parsed.error}
                </p>
            )}
            <div>
                <Button
                    type="submit"
                    size="md"
                    variant="primary"
                    disabled={!dirty || !parsed.ok || update.isPending}
                    loading={update.isPending}>
                    Save
                </Button>
            </div>
        </form>
    );
};

/** The owner's sandbox section of the Runtime settings page (self-hosted only). */
export const SandboxCapacitySection = () => {
    const view = useSandboxCapacity();
    return (
        <RuntimeSection
            id="sandboxes"
            title="Sandboxes"
            description="How many review sandboxes this installation holds at once, and how long a review waits in line for one. No deploy needed to change it.">
            {view.isLoading ? (
                <Skeleton className="h-40 w-full" />
            ) : view.isError || !view.data ? (
                <p className="text-text-secondary text-sm">
                    Sandbox capacity is not available right now. Try again in a moment.
                </p>
            ) : (
                <SandboxCapacityForm
                    key={JSON.stringify(view.data.settings)}
                    view={view.data}
                />
            )}
        </RuntimeSection>
    );
};
