/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";

import UsagePage from "./page";

let mockReleased = true;
jest.mock("src/core/feature-gate/kody-runtime", () => ({
    isKodyRuntimeReleased: () => Promise.resolve(mockReleased),
}));
jest.mock("./llm-tokens-tab", () => ({
    LlmTokensTab: () => <p>llm tokens content</p>,
}));
jest.mock("./_components/runtime-machines-tab", () => ({
    RuntimeMachinesTab: () => <p>runtime machines content</p>,
}));
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: jest.fn() }),
    usePathname: () => "/token-usage",
}));

const mount = async (searchParams: Record<string, string> = {}) =>
    render(await UsagePage({ searchParams }));

beforeEach(() => {
    mockReleased = true;
});

describe("the Usage screen", () => {
    it("is the Token Usage screen as it was when Kody Runtime is not released", async () => {
        mockReleased = false;
        await mount({ tab: "runtime" });

        expect(
            screen.getByRole("heading", { name: "Token Usage" }),
        ).toBeInTheDocument();
        expect(screen.queryByRole("tab")).not.toBeInTheDocument();
        expect(screen.getByText("llm tokens content")).toBeInTheDocument();
        expect(
            screen.queryByText("runtime machines content"),
        ).not.toBeInTheDocument();
    });

    it("opens on LLM tokens, with both tabs, when Kody Runtime is released", async () => {
        await mount();

        expect(
            screen.getByRole("heading", { name: "Usage" }),
        ).toBeInTheDocument();
        expect(
            screen.getAllByRole("tab").map((tab) => tab.textContent),
        ).toEqual(["LLM tokens", "Runtime machines"]);
        expect(screen.getByText("llm tokens content")).toBeInTheDocument();
        expect(
            screen.queryByText("runtime machines content"),
        ).not.toBeInTheDocument();
    });

    it("opens on Runtime machines when the URL says ?tab=runtime", async () => {
        await mount({ tab: "runtime" });

        expect(
            screen.getByText("runtime machines content"),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("llm tokens content"),
        ).not.toBeInTheDocument();
    });

    it("ignores an unknown tab", async () => {
        await mount({ tab: "nope" });
        expect(screen.getByText("llm tokens content")).toBeInTheDocument();
    });
});
