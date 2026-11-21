/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen } from "@testing-library/react";

import { UsageTabs } from "./usage-tabs";

const push = jest.fn();
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push }),
    usePathname: () => "/token-usage",
}));

const mount = (active: "llm" | "runtime") =>
    render(
        <UsageTabs
            active={active}
            llm={<p>llm content</p>}
            runtime={<p>runtime content</p>}
        />,
    );

beforeEach(() => push.mockReset());

describe("the Usage tabs", () => {
    it("opens the LLM tokens tab and renders only its content", () => {
        mount("llm");
        expect(screen.getByRole("tab", { name: "LLM tokens" })).toHaveAttribute(
            "data-state",
            "active",
        );
        expect(screen.getByText("llm content")).toBeInTheDocument();
        expect(screen.queryByText("runtime content")).not.toBeInTheDocument();
    });

    it("opens the Runtime machines tab when the URL asks for it", () => {
        mount("runtime");
        expect(
            screen.getByRole("tab", { name: "Runtime machines" }),
        ).toHaveAttribute("data-state", "active");
        expect(screen.getByText("runtime content")).toBeInTheDocument();
        expect(screen.queryByText("llm content")).not.toBeInTheDocument();
    });

    it("puts the tab in the URL when one is chosen", () => {
        mount("llm");
        fireEvent.mouseDown(
            screen.getByRole("tab", { name: "Runtime machines" }),
        );
        expect(push).toHaveBeenCalledWith("/token-usage?tab=runtime");
    });

    it("drops the tab from the URL when going back to LLM tokens", () => {
        mount("runtime");
        fireEvent.mouseDown(screen.getByRole("tab", { name: "LLM tokens" }));
        expect(push).toHaveBeenCalledWith("/token-usage");
    });
});
