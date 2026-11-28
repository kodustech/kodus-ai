import type { RuntimePreview } from "../contracts";
import {
    durationWords,
    previewSettingsFromDraft,
    mayStopPreview,
    previewActivityText,
    previewSideStatus,
    previewStopsHint,
    canOpenPreview,
    isPreviewOff,
    PREVIEW_OFF_MESSAGE,
    previewErrorMessage,
    previewHref,
    previewSideOf,
    previewStep,
} from "./preview";

const view = (patch: Partial<RuntimePreview> = {}): RuntimePreview => ({
    previewId: "prv_abcdefghijklmnopqrstuvwxyz",
    runId: "run-1",
    environmentId: "env-1",
    repositoryId: "repo-1",
    side: "pr",
    sha: "a".repeat(40),
    host: "p-abcdefghijklmnopqrstuvwxyz-pr.preview.example",
    state: "starting",
    openedBy: "user-1",
    withoutSecrets: true,
    createdAt: "2026-11-12T12:00:00.000Z",
    expiresAt: "2026-11-19T12:00:00.000Z",
    ...patch,
});
const httpError = (statusCode: number, body: unknown) => ({ statusCode, body });

describe("preview flow", () => {
    it("waits for the record, then asks for the grant while it starts, is ready or sleeps", () => {
        expect(previewStep(undefined).kind).toBe("wait");
        for (const state of ["starting", "ready", "sleeping"] as const)
            expect(previewStep(view({ state })).kind).toBe("grant");
    });

    it("shows why it is blocked, and that a stopped or expired preview has ended", () => {
        expect(previewStep(view({ state: "blocked", reason: "No capacity right now." }))).toEqual({
            kind: "blocked",
            message: "No capacity right now.",
        });
        expect(previewStep(view({ state: "expired" })).kind).toBe("ended");
        expect(previewStep(view({ state: "stopped" })).kind).toBe("ended");
    });

    it("names the missing preview domain when the deployment has previews off", () => {
        const off = httpError(409, { data: { code: "preview_off", message: "worker text" } });
        expect(isPreviewOff(off)).toBe(true);
        expect(previewErrorMessage(off)).toBe(PREVIEW_OFF_MESSAGE);
        expect(previewErrorMessage(httpError(503, { code: "preview_off" }))).toBe(PREVIEW_OFF_MESSAGE);
        expect(previewErrorMessage(httpError(409, { message: "This Run has not finished yet." }))).toBe(
            "This Run has not finished yet.",
        );
        expect(previewErrorMessage(httpError(404, {}))).toMatch(/not yours to open/);
    });

    it("opens only a finished, not halted Run of one repository, on this app's own page", () => {
        expect(canOpenPreview({ state: "regression" })).toBe(true);
        expect(canOpenPreview({ state: "testing" })).toBe(false);
        expect(canOpenPreview({ state: "halted" })).toBe(false);
        expect(canOpenPreview({ state: "no_regressions", workspace: [{} as never] })).toBe(false);
        expect(previewHref("run/1", "base")).toBe("/runtime/runs/run%2F1/preview?side=base");
        expect(previewSideOf("pr")).toBe("pr");
        expect(previewSideOf("main")).toBeNull();
    });
});

describe("the preview card", () => {
    it("names each state the way the card shows it, and what a click does", () => {
        expect(previewSideStatus(undefined)).toMatchObject({ label: "Not started", canOpen: true, canStop: false });
        expect(previewSideStatus(view({ state: "sleeping" }))).toMatchObject({ label: "Sleeping, wakes on open", canOpen: true });
        expect(previewSideStatus(view({ state: "ready" }))).toMatchObject({ label: "Ready", canStop: true });
        expect(previewSideStatus(view({ state: "blocked", reason: "No capacity right now. Open it again in a few minutes." })).label).toBe("No capacity right now. Open it again in a few minutes.");
        expect(previewSideStatus(view({ state: "expired", reason: "This preview is of an older commit. Open the newest Run of the pull request." }))).toMatchObject({ canOpen: false, label: expect.stringContaining("older commit") });
        // A security stop is not reopened from the card.
        expect(previewSideStatus(view({ state: "stopped", reason: "Stopped by a security event on the preview machine. An owner can see it in the preview activity." })).canOpen).toBe(false);
        expect(previewSideStatus(view({ state: "stopped", reason: "Stopped by a member." })).canOpen).toBe(true);
    });

    it("says when a preview stops by itself in plain words", () => {
        expect(previewStopsHint({ idleMinutes: 15, ceilingMinutes: 120 })).toBe("Stops after 15 minutes without use. Up to 2 hours per start.");
        expect(durationWords(60)).toBe("1 hour");
        expect(durationWords(90)).toBe("90 minutes");
    });

    it("offers Stop to the opener and to an owner only, while it holds or can wake machines", () => {
        expect(mayStopPreview(view({ state: "ready" }), "user-1", false)).toBe(true);
        expect(mayStopPreview(view({ state: "ready" }), "user-2", false)).toBe(false);
        expect(mayStopPreview(view({ state: "ready" }), "user-2", true)).toBe(true);
        expect(mayStopPreview(view({ state: "expired" }), "user-1", true)).toBe(false);
    });

    it("writes activity rows in words, never a raw code", () => {
        expect(previewActivityText({ action: "slept", reason: "idle" })).toBe("Went to sleep (no use)");
        expect(previewActivityText({ action: "stopped", reason: "security_event" })).toBe("Stopped (a security event)");
        expect(previewActivityText({ action: "session_opened" })).toBe("Opened");
    });
});

describe("the preview settings form", () => {
    const draft = { enabled: true, forks: "off" as const, idleMinutes: "15", ceilingMinutes: 120, monthlyMachineMinutes: "" };
    it("turns an empty cap into no cap and keeps the defaults as typed", () => {
        expect(previewSettingsFromDraft(draft)).toEqual({ ok: true, settings: { enabled: true, forks: "off", idleMinutes: 15, ceilingMinutes: 120, monthlyMachineMinutes: null } });
        expect(previewSettingsFromDraft({ ...draft, monthlyMachineMinutes: " 600 " })).toMatchObject({ ok: true, settings: { monthlyMachineMinutes: 600 } });
    });
    it("names what to fix when a number is out of bounds", () => {
        expect(previewSettingsFromDraft({ ...draft, idleMinutes: "2" })).toEqual({ ok: false, error: expect.stringContaining("5 to 60") });
        expect(previewSettingsFromDraft({ ...draft, monthlyMachineMinutes: "10" })).toEqual({ ok: false, error: expect.stringContaining("Monthly cap") });
        expect(previewSettingsFromDraft({ ...draft, idleMinutes: "7.5" }).ok).toBe(false);
    });
});
