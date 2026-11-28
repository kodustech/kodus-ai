/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { act, fireEvent, render, screen } from "@testing-library/react";

import {
    InlineDisclosure,
    openDisclosure,
    RuntimeDisclosure,
} from "./disclosure";

describe("RuntimeDisclosure", () => {
    it("is closed by default and says what is inside on its summary", () => {
        render(
            <RuntimeDisclosure
                id="run-timing"
                title="Why it took 9 min 51 s"
                summary="Most of it was building this PR (7 min 51 s).">
                <p>The phases</p>
            </RuntimeDisclosure>,
        );
        const heading = screen.getByRole("heading", {
            name: "Why it took 9 min 51 s",
        });
        const details = heading.closest("details")!;
        expect(details.open).toBe(false);
        expect(details.querySelector("summary")).toHaveTextContent(
            "Why it took 9 min 51 sMost of it was building this PR (7 min 51 s).",
        );
    });

    it("opens and closes from its summary, and stays as the reader left it when the page re-renders", () => {
        const { rerender } = render(
            <RuntimeDisclosure title="Run log" defaultOpen>
                <p>lines</p>
            </RuntimeDisclosure>,
        );
        const details = screen
            .getByRole("heading", { name: "Run log" })
            .closest("details")!;
        const summary = details.querySelector("summary")!;
        expect(details.open).toBe(true);
        fireEvent.click(summary);
        expect(details.open).toBe(false);
        // A live Run that ends re-renders with defaultOpen false: nothing moves under the reader.
        fireEvent.click(summary);
        rerender(
            <RuntimeDisclosure title="Run log" defaultOpen={false}>
                <p>lines</p>
            </RuntimeDisclosure>,
        );
        expect(details.open).toBe(true);
    });

    it("opens when the page's fragment names it, or when a link asks", () => {
        window.location.hash = "";
        render(
            <>
                <RuntimeDisclosure id="run-cost" title="Cost">
                    <p>breakdown</p>
                </RuntimeDisclosure>
                <InlineDisclosure label="Evidence">
                    <p id="inside">x</p>
                </InlineDisclosure>
            </>,
        );
        const cost = screen
            .getByRole("heading", { name: "Cost" })
            .closest("details")!;
        expect(cost.open).toBe(false);
        act(() => {
            window.location.hash = "#run-cost";
            window.dispatchEvent(new HashChangeEvent("hashchange"));
        });
        expect(cost.open).toBe(true);
        cost.open = false;
        openDisclosure("run-cost");
        expect(cost.open).toBe(true);
    });

    it("opens when the fragment names a section inside it", () => {
        window.location.hash = "#machine-size";
        render(
            <RuntimeDisclosure
                id="settings"
                title="Settings"
                openFor={["machine-size"]}>
                <section id="machine-size">sizes</section>
            </RuntimeDisclosure>,
        );
        expect(
            screen
                .getByRole("heading", { name: "Settings" })
                .closest("details")!.open,
        ).toBe(true);
        window.location.hash = "";
    });

    it("stays closed, without throwing, when the fragment holds a malformed escape", () => {
        window.location.hash = "#%ZZ";
        render(
            <RuntimeDisclosure id="run-cost" title="Cost">
                <p>breakdown</p>
            </RuntimeDisclosure>,
        );
        expect(
            screen.getByRole("heading", { name: "Cost" }).closest("details")!
                .open,
        ).toBe(false);
        window.location.hash = "";
    });
});

describe("InlineDisclosure", () => {
    it("is closed by default, its label and takeaway on the summary", () => {
        render(
            <InlineDisclosure
                label="Step-by-step replay"
                summary="Same request; main answered 404, this PR 200.">
                <p>lanes</p>
            </InlineDisclosure>,
        );
        const summary = screen
            .getByText("Step-by-step replay")
            .closest("summary")!;
        expect((summary.parentElement as HTMLDetailsElement).open).toBe(false);
        expect(summary).toHaveTextContent(
            "Step-by-step replaySame request; main answered 404, this PR 200.",
        );
    });
});
