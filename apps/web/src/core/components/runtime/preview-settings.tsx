"use client";

import { useState } from "react";
import { RelativeTime } from "@components/runtime/relative-time";
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
import { Switch } from "@components/ui/switch";
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
import type { RuntimePreviewSettingsView } from "@services/runtime/contracts";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    durationWords,
    PREVIEW_CEILING_CHOICES,
    PREVIEW_OFF_MESSAGE,
    previewActivityText,
    previewSettingsFromDraft,
    type PreviewSettingsDraft,
} from "@services/runtime/model/preview";
import {
    usePreviewActivity,
    usePreviewSettings,
    useUpdatePreviewSettings,
} from "@services/runtime/queries";

// Kody Runtime → Settings → Preview (docs/runtime/preview-urls.md §8.4), the
// owner's: on or off, forks, when a preview stops by itself, the monthly
// cap, and the activity of every preview (runtime_preview_audit).

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <div className="flex flex-col gap-1.5">
        <Label className="text-text-primary text-sm">{label}</Label>
        {children}
        {hint && <span className="text-text-tertiary text-xs">{hint}</span>}
    </div>
);

const draftOf = (v: RuntimePreviewSettingsView): PreviewSettingsDraft => ({
    enabled: v.settings.enabled,
    forks: v.settings.forks,
    idleMinutes: String(v.settings.idleMinutes),
    ceilingMinutes: v.settings.ceilingMinutes,
    monthlyMachineMinutes: v.settings.monthlyMachineMinutes === null ? "" : String(v.settings.monthlyMachineMinutes),
});

const PreviewSettingsForm = ({ view }: { view: RuntimePreviewSettingsView }) => {
    const [draft, setDraft] = useState<PreviewSettingsDraft>(() => draftOf(view));
    const update = useUpdatePreviewSettings();
    const parsed = previewSettingsFromDraft(draft);
    const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(view));
    const disabled = !view.available || update.isPending;
    const set = (patch: Partial<PreviewSettingsDraft>) => setDraft((d) => ({ ...d, ...patch }));
    const used = view.usedMinutesThisMonth;
    const cap = view.settings.monthlyMachineMinutes;

    return (
        <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
                event.preventDefault();
                if (!parsed.ok || !dirty) return;
                update.mutate(parsed.settings, {
                    onSuccess: () => toast({ variant: "success", title: "Preview settings saved", description: "They apply the next time a preview opens." }),
                    onError: (error) =>
                        toast({
                            variant: "danger",
                            title: "Couldn't save the preview settings",
                            description: runtimeErrorMessage(error, { fallback: "Try again in a moment.", 403: "Only the owner of the organization can change them." }),
                        }),
                });
            }}>
            {!view.available && (
                <p className="text-warning text-sm" role="status">
                    {PREVIEW_OFF_MESSAGE} Until then, nothing here takes effect.
                </p>
            )}
            <label className="flex items-center gap-3 text-sm">
                <Switch checked={draft.enabled} disabled={disabled} onCheckedChange={(enabled) => set({ enabled })} aria-label="Previews" />
                <span className="flex flex-col">
                    <span className="text-text-primary">Previews {draft.enabled ? "on" : "off"}</span>
                    <span className="text-text-tertiary text-xs">
                        Members open a finished Run&apos;s app from the Run page or the pull request comment. Only members with access to the repository can open it.
                    </span>
                </span>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Pull requests from forks" hint="When on, only a commit a maintainer approved and a Run tested, and never with your secrets.">
                    <Select value={draft.forks} onValueChange={(v) => set({ forks: v === "members" ? "members" : "off" })} disabled={disabled}>
                        <SelectTrigger aria-label="Pull requests from forks">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="off">Off (recommended)</SelectItem>
                            <SelectItem value="members">Members, after approval</SelectItem>
                        </SelectContent>
                    </Select>
                </Field>
                <Field label="Stop after this many idle minutes" hint="15 by default. A stopped preview wakes on the next visit.">
                    <Input type="number" min={5} max={60} step={1} inputMode="numeric" aria-label="Idle minutes" value={draft.idleMinutes} disabled={disabled} onChange={(e) => set({ idleMinutes: e.target.value })} />
                </Field>
                <Field label="Longest time per start" hint="2 hours by default; a visit after it boots the preview again.">
                    <Select value={String(draft.ceilingMinutes)} onValueChange={(v) => set({ ceilingMinutes: Number(v) })} disabled={disabled}>
                        <SelectTrigger aria-label="Longest time per start">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {PREVIEW_CEILING_CHOICES.map((m) => (
                                <SelectItem key={m} value={String(m)}>
                                    {durationWords(m)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
                <Field
                    label="Monthly cap (machine-minutes)"
                    hint={`Empty: no cap. ${used === null ? "" : `Used this month: ${used.toLocaleString()}${cap ? ` of ${cap.toLocaleString()}` : ""}. `}Past it, previews do not start until next month.`}>
                    <Input type="number" min={60} step={60} inputMode="numeric" aria-label="Monthly cap" placeholder="No cap" value={draft.monthlyMachineMinutes} disabled={disabled} onChange={(e) => set({ monthlyMachineMinutes: e.target.value })} />
                </Field>
            </div>
            <p className="text-text-tertiary text-xs">
                Secrets in previews are set per environment, on the environment page. Preview machine time shows in Usage.
            </p>
            {!parsed.ok && dirty && (
                <p className="text-danger text-sm" role="alert">
                    {parsed.error}
                </p>
            )}
            <div>
                <Button type="submit" size="md" variant="primary" disabled={disabled || !dirty || !parsed.ok} loading={update.isPending}>
                    Save
                </Button>
            </div>
        </form>
    );
};

const PreviewActivity = () => {
    const activity = usePreviewActivity();
    if (activity.isLoading) return <Skeleton className="h-24 w-full" />;
    if (activity.isError || !activity.data)
        return <p className="text-text-secondary text-sm">Preview activity is not available on this deployment right now.</p>;
    if (!activity.data.items.length) return <p className="text-text-secondary text-sm">No preview opened yet.</p>;
    return (
        <TableContainer>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>When</TableHead>
                        <TableHead>What</TableHead>
                        <TableHead>Side</TableHead>
                        <TableHead>Who</TableHead>
                        <TableHead>Preview</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {activity.data.items.map((r, i) => (
                        <TableRow key={`${r.at}:${r.previewId}:${i}`}>
                            <TableCell className="text-xs">
                                <RelativeTime at={r.at} />
                            </TableCell>
                            <TableCell className="text-sm">{previewActivityText(r)}</TableCell>
                            <TableCell className="text-xs">{r.side === "pr" ? "PR" : r.side === "base" ? "Base" : ""}</TableCell>
                            <TableCell className="font-mono text-xs">{r.actor ? r.actor.slice(0, 8) : "Kodus"}</TableCell>
                            <TableCell className="font-mono text-xs">{r.previewId.slice(4, 12)}</TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </TableContainer>
    );
};

/** The owner's preview section of the Runtime settings page. */
export const RuntimePreviewSettingsSection = () => {
    const view = usePreviewSettings();
    return (
        <RuntimeSection
            id="preview"
            title="Preview"
            description="Let members open the app a Run booted in their browser. Each side boots on its own machines, on demand, and stops by itself.">
            {view.isLoading ? (
                <Skeleton className="h-40 w-full" />
            ) : view.isError || !view.data ? (
                <p className="text-text-secondary text-sm">Preview settings are not available right now. Try again in a moment.</p>
            ) : (
                <PreviewSettingsForm key={JSON.stringify(view.data.settings)} view={view.data} />
            )}
            <div className="flex flex-col gap-2">
                <span className="text-text-primary text-sm font-semibold">Activity</span>
                <span className="text-text-tertiary text-xs">Every open, refusal, start, sleep, stop and end of a preview, newest first. Kept 30 days.</span>
                <PreviewActivity />
            </div>
        </RuntimeSection>
    );
};
