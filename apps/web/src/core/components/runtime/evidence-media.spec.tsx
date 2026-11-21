/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { getRunEvidenceUrl } from "@services/runtime/api";
import { act, render, screen } from "@testing-library/react";

import { EvidenceImage, EvidenceVideo } from "./evidence-media";

jest.mock("@services/runtime/api", () => ({ getRunEvidenceUrl: jest.fn() }));

// WP9: every screenshot and recording of every finding minted its signed URL
// when the page opened, and again every 4.5 minutes, even inside a closed
// "Evidence". Now only what is on screen is minted.

const mint = getRunEvidenceUrl as jest.Mock;
const STEP = "6f1c2b0e-4d3a-4b5c-9d8e-7f6a5b4c3d2e";

/** An IntersectionObserver the test drives: `show(true)` puts every observed element on screen. */
let observed: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
const show = (on: boolean) => act(() => observed.forEach((cb) => cb([{ isIntersecting: on }])));

const flush = () =>
    act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });

describe("evidence media", () => {
    beforeEach(() => {
        observed = [];
        (globalThis as any).IntersectionObserver = class {
            constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
                observed.push(cb);
            }
            observe() {}
            disconnect() {}
        };
        mint.mockReset().mockImplementation(async (p: { type: string }) => ({
            url: `${window.location.origin.replace("http://", "https://evidence.")}/x/${p.type}?sig=1`,
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }));
    });
    afterEach(() => {
        delete (globalThis as any).IntersectionObserver;
    });

    it("mints nothing while off screen, and mints when it comes on screen", async () => {
        render(
            <>
                <EvidenceImage runId="run-1" stepId={STEP} side="base" type="screenshot" alt="base" />
                <EvidenceVideo runId="run-1" stepId={STEP} side="pr" label="pr" available />
            </>,
        );
        await flush();
        expect(mint).not.toHaveBeenCalled();
        show(true);
        await flush();
        expect(mint).toHaveBeenCalledTimes(2);
    });

    // N5: scrolled away and back, a still-valid URL is kept: the recording does not restart and nothing is minted again.
    it("keeps a still-valid URL when it comes back on screen", async () => {
        render(<EvidenceImage runId="run-1" stepId={STEP} side="base" type="screenshot" alt="base" />);
        show(true);
        await flush();
        const src = screen.getByAltText("base").getAttribute("src");
        show(false);
        await flush();
        show(true);
        await flush();
        expect(mint).toHaveBeenCalledTimes(1);
        expect(screen.getByAltText("base").getAttribute("src")).toBe(src);
    });

    it("mints again when it comes back on screen after its URL ran out", async () => {
        mint.mockImplementation(async (p: { type: string }) => ({
            url: `${window.location.origin.replace("http://", "https://evidence.")}/x/${p.type}?sig=1`,
            expiresAt: new Date(Date.now() + 10_000).toISOString(),
        }));
        render(<EvidenceImage runId="run-1" stepId={STEP} side="base" type="screenshot" alt="base" />);
        show(true);
        await flush();
        show(false);
        await flush();
        show(true);
        await flush();
        expect(mint).toHaveBeenCalledTimes(2);
    });

    it("mints at once where the browser cannot say what is on screen", async () => {
        delete (globalThis as any).IntersectionObserver;
        render(<EvidenceVideo runId="run-1" stepId={STEP} side="pr" label="pr" available />);
        await flush();
        expect(mint).toHaveBeenCalledTimes(1);
    });
});
