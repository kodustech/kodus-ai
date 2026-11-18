/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { StrictMode, type ReactNode } from "react";
import type { RuntimePreview } from "@services/runtime/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";

import { RunPreviewPage } from "./_page-component";

const mockApi = {
    openRunPreview: jest.fn(),
    getRunPreview: jest.fn(),
    grantRunPreview: jest.fn(),
};
jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
jest.mock("@services/runtime/api", () => ({
    openRunPreview: (...a: unknown[]) => mockApi.openRunPreview(...a),
    getRunPreview: (...a: unknown[]) => mockApi.getRunPreview(...a),
    grantRunPreview: (...a: unknown[]) => mockApi.grantRunPreview(...a),
}));

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

const renderPage = (navigate: (url: string) => void, side: "pr" | "base" | null = "pr", strict = false) => {
    const page = (
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <RunPreviewPage runId="run-1" side={side} navigate={navigate} />
        </QueryClientProvider>
    );
    return render(strict ? <StrictMode>{page}</StrictMode> : page);
};

beforeEach(() => jest.clearAllMocks());

describe("RunPreviewPage", () => {
    // React mounts, unmounts and mounts again under StrictMode (next dev): a
    // result read through the first mount's mutation observer never arrives
    // (dev VM, 2026-11-13: the page stayed on "Starting preview…").
    it("under StrictMode, still opens once, grants once and sends the tab to the grant URL", async () => {
        mockApi.openRunPreview.mockResolvedValue(view());
        mockApi.getRunPreview.mockResolvedValue(view());
        const url = "https://p-abcdefghijklmnopqrstuvwxyz-pr.preview.example/__kodus/session?grant=g&to=%2F";
        mockApi.grantRunPreview.mockResolvedValue({ redirectUrl: url, expiresAt: "2026-11-12T12:01:00.000Z" });
        const navigate = jest.fn();
        renderPage(navigate, "pr", true);
        await waitFor(() => expect(navigate).toHaveBeenCalledWith(url));
        expect(mockApi.openRunPreview).toHaveBeenCalledTimes(1);
        expect(mockApi.grantRunPreview).toHaveBeenCalledTimes(1);
    });

    it("under StrictMode, shows why the open failed", async () => {
        mockApi.openRunPreview.mockRejectedValue({ statusCode: 409, body: { code: "preview_off", message: "off" } });
        renderPage(jest.fn(), "pr", true);
        expect(await screen.findByText(/Set RUNTIME_PREVIEW_DOMAIN/)).toBeInTheDocument();
    });

    it("opens the side, asks one grant, and sends the tab to the grant URL", async () => {
        mockApi.openRunPreview.mockResolvedValue(view());
        mockApi.getRunPreview.mockResolvedValue(view());
        const url = "https://p-abcdefghijklmnopqrstuvwxyz-pr.preview.example/__kodus/session?grant=g&to=%2F";
        mockApi.grantRunPreview.mockResolvedValue({ redirectUrl: url, expiresAt: "2026-11-12T12:01:00.000Z" });
        const navigate = jest.fn();
        renderPage(navigate);
        expect(screen.getByText("Starting preview…")).toBeInTheDocument();
        await waitFor(() => expect(navigate).toHaveBeenCalledWith(url));
        expect(mockApi.openRunPreview).toHaveBeenCalledTimes(1);
        expect(mockApi.openRunPreview).toHaveBeenCalledWith("run-1", "pr");
        expect(mockApi.grantRunPreview).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["another host", "https://evil.example/__kodus/session?grant=g"],
        ["a script URL", "javascript:alert(1)"],
        ["plain http", "http://p-abcdefghijklmnopqrstuvwxyz-pr.preview.example/__kodus/session?grant=g"],
    ])("refuses a grant URL on %s, says so, and stays on this page", async (_what, url) => {
        mockApi.openRunPreview.mockResolvedValue(view());
        mockApi.getRunPreview.mockResolvedValue(view());
        mockApi.grantRunPreview.mockResolvedValue({ redirectUrl: url, expiresAt: "2026-11-12T12:01:00.000Z" });
        const navigate = jest.fn();
        renderPage(navigate);
        expect(await screen.findByText(/not the preview's address/)).toBeInTheDocument();
        expect(navigate).not.toHaveBeenCalled();
    });

    it("says previews are off when the deployment has no preview domain, and asks no grant", async () => {
        mockApi.openRunPreview.mockRejectedValue({ statusCode: 409, body: { code: "preview_off", message: "off" } });
        const navigate = jest.fn();
        renderPage(navigate);
        expect(await screen.findByText(/Set RUNTIME_PREVIEW_DOMAIN/)).toBeInTheDocument();
        expect(mockApi.grantRunPreview).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });

    it("shows a blocked preview's reason and asks no grant", async () => {
        const blocked = view({ state: "blocked", reason: "No capacity right now." });
        mockApi.openRunPreview.mockResolvedValue(blocked);
        mockApi.getRunPreview.mockResolvedValue(blocked);
        const navigate = jest.fn();
        renderPage(navigate);
        expect(await screen.findByText(/No capacity right now\./)).toBeInTheDocument();
        expect(mockApi.grantRunPreview).not.toHaveBeenCalled();
    });

    it("opens nothing without a side", () => {
        renderPage(jest.fn(), null);
        expect(screen.getByText("Choose a side to preview")).toBeInTheDocument();
        expect(mockApi.openRunPreview).not.toHaveBeenCalled();
    });
});
