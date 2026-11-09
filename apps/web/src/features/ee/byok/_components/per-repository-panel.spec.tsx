/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { listModelOverrides } from "@services/organizationParameters/fetch";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";

import { PerRepositoryPanel } from "./per-repository-panel";

jest.mock("@services/organizationParameters/fetch", () => ({
    listModelOverrides: jest.fn(async () => ({
        overrides: [],
        mismatchedCount: 0,
        customAgentOverrides: [
            {
                scope: "repository",
                repositoryId: "r1",
                repositoryName: "acme/api",
                agentId: "a1",
                agentName: "API contracts",
                step: "run",
                model: "model-kimi",
            },
        ],
    })),
}));

const mount = () =>
    render(
        <QueryClientProvider
            client={
                new QueryClient({
                    defaultOptions: { queries: { retry: false } },
                })
            }>
            <PerRepositoryPanel
                teamId="team-1"
                models={[{ id: "model-kimi", label: "Kimi K2.7 Code" }]}
            />
        </QueryClientProvider>,
    );
describe("PerRepositoryPanel", () => {
    it("shows a repository's custom agent that pins a model, with the model (#2172)", async () => {
        mount();

        expect(await screen.findByText("API contracts")).toBeVisible();
        expect(screen.getByText("acme/api")).toBeVisible();
        expect(screen.getByText("custom agent")).toBeVisible();
        expect(screen.getByText("Kimi K2.7 Code")).toBeVisible();
        expect(
            screen.getByRole("link", { name: "API contracts" }),
        ).toHaveAttribute("href", "/settings/code-review/r1/agents/a1");
        expect(screen.getByRole("link", { name: "acme/api" })).toHaveAttribute(
            "href",
            "/settings/code-review/r1/routing",
        );
    });
    it("opens model overrides in repository and directory Routing, without inventing targets for orphaned entries", async () => {
        (listModelOverrides as jest.Mock).mockResolvedValueOnce({
            overrides: [
                {
                    scope: "repository",
                    repositoryId: "repo one",
                    repositoryName: "acme/api",
                    model: "model-kimi",
                },
                {
                    scope: "directory",
                    repositoryId: "repo one",
                    repositoryName: "acme/api",
                    directoryId: "dir?a",
                    directoryName: "payments",
                    model: "model-kimi",
                },
                {
                    scope: "repository",
                    repositoryName: "orphan",
                    model: "model-kimi",
                },
            ],
            mismatchedCount: 0,
        });
        mount();
        expect(
            await screen.findByRole("link", { name: "acme/api" }),
        ).toHaveAttribute("href", "/settings/code-review/repo%20one/routing");
        fireEvent.click(screen.getByRole("button", { name: "Expand" }));
        expect(screen.getByRole("link", { name: "payments" })).toHaveAttribute(
            "href",
            "/settings/code-review/repo%20one/routing?directoryId=dir%3Fa",
        );
        expect(screen.getByText("orphan")).toBeVisible();
        expect(
            screen.queryByRole("link", { name: "orphan" }),
        ).not.toBeInTheDocument();
    });
    it("does not claim repositories inherit models when the list fails, and supports Retry", async () => {
        (listModelOverrides as jest.Mock)
            .mockRejectedValueOnce(new Error("network fixture"))
            .mockResolvedValueOnce({ overrides: [], mismatchedCount: 0 });
        mount();
        await screen.findByText("Could not load repository overrides.");
        expect(
            screen.queryByText(/No repository overrides/),
        ).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(
            await screen.findByText(/No repository overrides/),
        ).toBeVisible();
    });
});
