import type { PreviewSide, RunState, RuntimePreview, RuntimePreviewAuditRecord, RuntimePreviewOffer, RuntimePreviewSettings, RuntimeRun } from "../contracts";
import { isTerminalRunState } from "../labels";
import { errorStatus, runtimeErrorMessage } from "./errors";

// Opening a Run preview from the web app (docs/runtime/preview-urls.md §8.2):
// the Run page links to /runtime/runs/:runId/preview?side=…, on this app's
// own origin, never to the preview host. That page opens the preview, waits
// for its record, then asks for a single-use grant and sends the browser to
// the preview host, which exchanges it for its own cookie.

export const PREVIEW_OFF_MESSAGE =
    "Previews are off on this deployment. Set RUNTIME_PREVIEW_DOMAIN to a domain other than the one Kodus runs on.";

/**
 * The grant URL the API answers, before this tab goes there: https, on the
 * preview's own host (the API builds `https://<host>[:port]/…`), never this
 * app's origin and never with credentials. Anything else is refused, so a bad
 * answer cannot send the tab to another site or run a script on this origin.
 */
export const checkPreviewGrantUrl = (
    raw: unknown,
    expect: { host: string; appOrigin: string },
): { ok: true; url: string } | { ok: false } => {
    if (typeof raw !== "string") return { ok: false };
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false };
    }
    const ok =
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !!expect.host &&
        url.hostname === expect.host.toLowerCase() &&
        url.origin !== expect.appOrigin;
    return ok ? { ok: true, url: url.toString() } : { ok: false };
};

/** A grant URL checkPreviewGrantUrl refused: the page says so instead of following it. */
export class PreviewGrantUrlRefused extends Error {
    constructor() {
        super(
            "The grant the API answered is not the preview's address, so this tab did not follow it.",
        );
    }
}

/** How often the page reads the preview while it waits for its record. */
export const PREVIEW_POLL_MS = 2_000;

export const previewSideOf = (value: string | null | undefined): PreviewSide | null =>
    value === "pr" || value === "base" ? value : null;

export const previewSideLabel = (side: PreviewSide) =>
    side === "pr" ? "PR version" : "base";

export const previewHref = (runId: string, side: PreviewSide) =>
    `/runtime/runs/${encodeURIComponent(runId)}/preview?side=${side}`;

/**
 * A Run whose preview can open: finished, not halted by a security event,
 * one repository (the API refuses the others with its reason).
 */
export const canOpenPreview = (
    run: Pick<RuntimeRun, "state"> & Partial<Pick<RuntimeRun, "workspace">>,
) =>
    isTerminalRunState(run.state as RunState) &&
    run.state !== "halted" &&
    !run.workspace?.length;

export type PreviewStep =
    | { kind: "wait"; message: string }
    | { kind: "grant" }
    | { kind: "blocked"; message: string }
    | { kind: "ended"; message: string };

/**
 * What the page does with the preview as it is now: wait for its record,
 * ask for the grant (the preview host shows its own "Starting" page while the
 * machines boot), show why it is blocked (and keep reading: a capacity block
 * retries), or say it ended.
 */
export function previewStep(view: RuntimePreview | null | undefined): PreviewStep {
    if (!view) return { kind: "wait", message: "Starting preview…" };
    switch (view.state) {
        case "starting":
        case "ready":
        case "sleeping":
            return { kind: "grant" };
        case "blocked":
            return {
                kind: "blocked",
                message: view.reason ?? "This preview could not start yet. Kodus keeps trying.",
            };
        default:
            return {
                kind: "ended",
                message: view.reason ?? "This preview has ended. Open it again from the Run.",
            };
    }
}

const codeOf = (body: unknown): string | undefined => {
    if (!body || typeof body !== "object") return undefined;
    const b = body as { code?: unknown; data?: unknown };
    return typeof b.code === "string" ? b.code : codeOf(b.data);
};

/** The deployment has no preview domain (or no grant key): the API's preview_off. */
export const isPreviewOff = (error: unknown) =>
    codeOf((error as { body?: unknown } | null)?.body) === "preview_off";

export const previewErrorMessage = (error: unknown): string => {
    if (error instanceof PreviewGrantUrlRefused) return error.message;
    if (isPreviewOff(error)) return PREVIEW_OFF_MESSAGE;
    if (errorStatus(error) === 409) return runtimeErrorMessage(error, { fallback: "This preview cannot open now." });
    if (errorStatus(error) === 404)
        return "This Run or preview does not exist, or it is not yours to open.";
    return runtimeErrorMessage(error, {
        fallback: "The preview could not open. Try again in a moment.",
        403: "Opening a preview needs access to this repository. Ask an owner of the organization.",
    });
};

export const environmentPreviewHref = (environmentId: string) =>
    `/runtime/environments/${encodeURIComponent(environmentId)}/preview`;

/** The ceiling as people say it: 2 hours, 1 hour, 90 minutes. */
export const durationWords = (minutes: number) =>
    minutes % 60 === 0
        ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}`
        : `${minutes} minutes`;

/** The card's one line about cost: when a preview stops by itself. */
export const previewStopsHint = (offer: Pick<RuntimePreviewOffer, "idleMinutes" | "ceilingMinutes">) =>
    `Stops after ${offer.idleMinutes} minutes without use. Up to ${durationWords(offer.ceilingMinutes)} per start.`;

export type PreviewTone = "neutral" | "busy" | "ok" | "warn";

/** What a side's state reads as on the card (§8.2), and what the button does. */
export function previewSideStatus(view: RuntimePreview | undefined): {
    label: string;
    tone: PreviewTone;
    /** Clicking opens (or wakes, or starts again) it: false once it can only be opened from a newer Run. */
    canOpen: boolean;
    /** Its record still has machines or can wake: Stop applies. */
    canStop: boolean;
} {
    switch (view?.state) {
        case undefined:
            return { label: "Not started", tone: "neutral", canOpen: true, canStop: false };
        case "starting":
            return { label: "Starting", tone: "busy", canOpen: true, canStop: true };
        case "ready":
            return { label: "Ready", tone: "ok", canOpen: true, canStop: true };
        case "sleeping":
            return { label: "Sleeping, wakes on open", tone: "neutral", canOpen: true, canStop: true };
        case "blocked":
            return { label: view.reason && view.reason !== "reopen" ? view.reason : "Could not start; opening it tries again", tone: "warn", canOpen: true, canStop: true };
        case "stopped":
            return { label: view.reason ?? "Stopped", tone: "neutral", canOpen: view.reason?.startsWith("Stopped by a security event") !== true, canStop: false };
        default:
            return { label: view?.reason ?? "Expired", tone: "neutral", canOpen: false, canStop: false };
    }
}

/** Only the opener or an owner may stop a preview (the API checks it again). */
export const mayStopPreview = (view: RuntimePreview | undefined, userId: string | undefined, isOwner: boolean) =>
    !!view && previewSideStatus(view).canStop && (isOwner || (!!userId && view.openedBy === userId));

const ACTIVITY: Record<RuntimePreviewAuditRecord["action"], string> = {
    session_opened: "Opened",
    session_refused: "Refused",
    session_closed: "Session ended",
    started: "Started",
    woken: "Woke up",
    slept: "Went to sleep",
    stopped: "Stopped",
    expired: "Ended",
};
const REASON: Record<string, string> = {
    idle: "no use",
    ceiling: "reached its time per start",
    lease_lost: "its machine went away",
    security_event: "a security event",
    no_access: "no access",
    other_org: "another organization",
    expired: "ended",
    grant_invalid: "invalid link",
    grant_replayed: "link used twice",
    not_found: "unknown preview",
};

/** One activity row in words: "Went to sleep (no use)". Never a raw code. */
export const previewActivityText = (r: Pick<RuntimePreviewAuditRecord, "action" | "reason">) => {
    const what = ACTIVITY[r.action] ?? r.action;
    const why = r.reason ? (REASON[r.reason] ?? null) : null;
    return why ? `${what} (${why})` : what;
};

/** The settings form as typed: numbers as text, the cap empty for none. */
export interface PreviewSettingsDraft {
    enabled: boolean;
    forks: "off" | "members";
    idleMinutes: string;
    ceilingMinutes: number;
    monthlyMachineMinutes: string;
}

export const PREVIEW_CEILING_CHOICES = [30, 60, 90, 120] as const;

/** The form's values, or the first thing to fix in words; the API checks the same bounds. */
export function previewSettingsFromDraft(
    draft: PreviewSettingsDraft,
): { ok: true; settings: RuntimePreviewSettings } | { ok: false; error: string } {
    const idle = Number(draft.idleMinutes);
    if (!Number.isInteger(idle) || idle < 5 || idle > 60) return { ok: false, error: "Stop after: a whole number of minutes from 5 to 60." };
    const capText = draft.monthlyMachineMinutes.trim();
    const cap = capText === "" ? null : Number(capText);
    if (cap !== null && (!Number.isInteger(cap) || cap < 60 || cap > 1_000_000)) {
        return { ok: false, error: "Monthly cap: leave it empty for no cap, or a whole number of machine-minutes from 60." };
    }
    return {
        ok: true,
        settings: { enabled: draft.enabled, forks: draft.forks, idleMinutes: idle, ceilingMinutes: draft.ceilingMinutes, monthlyMachineMinutes: cap },
    };
}
