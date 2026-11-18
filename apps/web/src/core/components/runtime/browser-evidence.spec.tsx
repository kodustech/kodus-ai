/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import { getRunEvidenceUrl } from "@services/runtime/api";
import { browserLanes } from "@services/runtime/model/__fixtures__/browser-lanes";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { BrowserEvidence } from "./browser-evidence";

jest.mock("@services/runtime/api", () => ({ getRunEvidenceUrl: jest.fn() }));
jest.mock("./evidence-link", () => ({
    EvidenceLink: ({
        children,
        type,
    }: {
        children: ReactNode;
        type?: string;
    }) => (
        <button type="button" data-type={type}>
            {children}
        </button>
    ),
}));

const EVIDENCE = "https://evidence.kodus.test";
const mint = getRunEvidenceUrl as jest.Mock;

const flush = () =>
    act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });

describe("BrowserEvidence", () => {
    beforeEach(() => {
        mint.mockReset();
        mint.mockImplementation(
            async (p: { stepId: string; side: string; type: string }) => ({
                url: `${EVIDENCE}/org/run/${p.side}/${p.stepId}/${p.type}?exp=1&sig=x`,
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
            }),
        );
    });

    it.each(["release/2026", undefined])(
        "names the base in browser steps, images, slider and downloads (%j)",
        async (baseLabel) => {
            const label = baseLabel || "base version";
            render(
                <BrowserEvidence
                    runId="run-1"
                    lanes={browserLanes()}
                    baseLabel={baseLabel}
                />,
            );
            await flush();
            const steps = screen.getByRole("region", { name: "Steps" });
            expect(
                within(steps).getAllByRole("button")[3],
            ).toHaveAccessibleName(
                new RegExp(`${label} passed, this PR failed`),
            );
            fireEvent.change(
                screen.getByRole("combobox", { name: "Screenshot" }),
                { target: { value: "0" } },
            );
            await flush();
            expect(
                screen.getByRole("img", {
                    name: new RegExp(`^${label} at step`),
                }),
            ).toBeInTheDocument();
            expect(
                screen.getByRole("button", {
                    name: `Playwright trace (${label})`,
                }),
            ).toBeInTheDocument();
            fireEvent.click(screen.getByRole("button", { name: "Slider" }));
            await flush();
            expect(
                screen.getByRole("slider", {
                    name: `Slide between this PR and ${label}`,
                }),
            ).toBeInTheDocument();
        },
    );

    it("shows the steps as chips with the first difference, and what each side read", async () => {
        render(<BrowserEvidence runId="run-1" lanes={browserLanes()} />);
        await flush();
        const steps = screen.getByRole("region", { name: "Steps" });
        const chips = within(steps).getAllByRole("button");
        expect(chips).toHaveLength(4);
        expect(chips[3]).toHaveAccessibleName(
            /base version passed, this PR failed\. First difference/,
        );
        expect(chips[3]).toHaveAttribute("aria-pressed", "true");
        expect(
            within(steps).getByText("keyboard × 2 monitor × 1", {
                normalizer: (s) => s.replace(/\s+/g, " "),
            }),
        ).toBeInTheDocument();
        expect(within(steps).getByText("(empty)")).toBeInTheDocument();
    });

    it("shows screenshots only by signed URLs on the evidence origin, side by side, under a slider, or as the pixel diff", async () => {
        render(<BrowserEvidence runId="run-1" lanes={browserLanes()} />);
        await flush();
        // The first difference's pair: only this PR took a screenshot at step 4.
        const shots = screen.getByRole("region", { name: "Screenshots" });
        fireEvent.change(
            within(shots).getByRole("combobox", { name: "Screenshot" }),
            { target: { value: "0" } },
        );
        await flush();
        const imgs = within(shots).getAllByRole("img");
        expect(imgs.map((i) => i.getAttribute("src"))).toEqual([
            `${EVIDENCE}/org/run/base/0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d/screenshot-0?exp=1&sig=x`,
            `${EVIDENCE}/org/run/pr/1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f/screenshot-0?exp=1&sig=x`,
        ]);
        expect(
            within(shots).getByText("4.1 % of pixels changed"),
        ).toBeInTheDocument();
        fireEvent.click(
            within(shots).getByRole("button", { name: "Pixel diff" }),
        );
        await flush();
        expect(within(shots).getByRole("img").getAttribute("src")).toContain(
            "/pr/1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f/pixeldiff-0?",
        );
        fireEvent.click(within(shots).getByRole("button", { name: "Slider" }));
        await flush();
        expect(within(shots).getAllByRole("img")).toHaveLength(2);
        expect(
            within(shots).getByRole("slider", {
                name: "Slide between this PR and base version",
            }),
        ).toBeInTheDocument();
        // Only URLs were asked for: the artifacts themselves are never read into the page.
        expect(
            mint.mock.calls.every(([p]) =>
                [
                    "screenshot-0",
                    "screenshot-1",
                    "pixeldiff-0",
                    "video",
                ].includes(p.type),
            ),
        ).toBe(true);
    });

    it("never shows an image whose URL is on the app's own origin", async () => {
        mint.mockImplementation(async () => ({
            url: `${window.location.origin}/evil.png`,
        }));
        render(<BrowserEvidence runId="run-1" lanes={browserLanes()} />);
        await flush();
        const shots = screen.getByRole("region", { name: "Screenshots" });
        expect(within(shots).queryByRole("img")).toBeNull();
        expect(
            within(shots).getAllByText("Screenshot unavailable").length,
        ).toBeGreaterThan(0);
    });

    it("plays the two recordings from the evidence origin and moves both to a step", async () => {
        render(<BrowserEvidence runId="run-1" lanes={browserLanes()} />);
        await flush();
        const rec = screen.getByRole("region", { name: "Recordings" });
        const [base, pr] = [
            within(rec).getByLabelText("Recording of base version"),
            within(rec).getByLabelText("Recording of this PR"),
        ] as HTMLVideoElement[];
        expect(base.getAttribute("src")).toMatch(
            new RegExp(`^${EVIDENCE}/org/run/base/.*/video\\?`),
        );
        expect(pr.getAttribute("src")).toMatch(
            new RegExp(`^${EVIDENCE}/org/run/pr/.*/video\\?`),
        );
        fireEvent.click(
            within(rec).getByRole("button", {
                name: "Go to step 4 in both recordings",
            }),
        );
        // Each side at its own step 4: (startMs - videoStartMs) / 1000.
        expect(base.currentTime).toBeCloseTo(1.08);
        expect(pr.currentTime).toBeCloseTo(1.09);
    });

    it("lists the page's console and network per side, and offers the trace and HAR downloads", async () => {
        render(<BrowserEvidence runId="run-1" lanes={browserLanes()} />);
        await flush();
        const log = screen.getByRole("region", { name: "Page log" });
        expect(
            within(log).getByText("warning order.qty is undefined"),
        ).toBeInTheDocument();
        expect(within(log).getByText("No console message")).toBeInTheDocument();
        fireEvent.click(within(log).getByRole("tab", { name: "Network" }));
        expect(
            within(log).getAllByText(
                /GET 200 http:\/\/app\.kody\.internal:3000\/orders/,
            ),
        ).toHaveLength(2);
        // A dev server's reload socket reaches the app but is no compared request.
        expect(
            within(log).getByText(
                /WebSockets to the app are allowed and not listed here; their messages are not compared/,
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Playwright trace (this PR)" }),
        ).toHaveAttribute("data-type", "trace");
        expect(
            screen.getByRole("button", { name: "HAR (base version)" }),
        ).toHaveAttribute("data-type", "har");
    });
});
