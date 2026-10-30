/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";

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

describe("PerRepositoryPanel", () => {
    it("shows a repository's custom agent that pins a model, with the model (#2172)", async () => {
        render(
            <PerRepositoryPanel
                teamId="team-1"
                models={[{ id: "model-kimi", label: "Kimi K2.7 Code" }]}
            />,
        );

        expect(await screen.findByText("API contracts")).toBeVisible();
        expect(screen.getByText("acme/api")).toBeVisible();
        expect(screen.getByText("custom agent")).toBeVisible();
        expect(screen.getByText("Kimi K2.7 Code")).toBeVisible();
        expect(
            screen.getByRole("link", { name: "API contracts" }),
        ).toHaveAttribute("href", "/settings/code-review/r1/agents/a1");
    });
});
