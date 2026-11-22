/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { CustomAgent } from "@services/custom-agents/types";
import { getBYOK } from "@services/organizationParameters/fetch";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
    CommentsAndModel,
    FilesAndKnowledge,
    InstructionsCard,
} from "./agent-sections";

// The knowledge card lists other repositories through the resolve endpoint.
jest.mock("@services/custom-agents/hooks", () => ({
    useResolveCustomAgent: () => ({
        isLoading: false,
        isFetching: false,
        data: undefined,
    }),
}));

jest.mock("@services/organizationParameters/fetch", () => ({
    getBYOK: jest.fn(),
}));

jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ children, href, ...rest }: any) => (
        <a href={typeof href === "string" ? href : ""} {...rest}>
            {children}
        </a>
    ),
}));

const agent: CustomAgent = {
    id: "ledger",
    name: "Ledger reviewer",
    enabled: false,
    instructions: "Every posting must balance.",
    scope: {},
    tools: {},
    presentation: {
        tag: { color: "#6366f1" },
        format: "inline",
        suggestedFix: "when-confident",
    },
};

describe("InstructionsCard", () => {
    it("defaults existing agents to every matching PR and saves only the new run condition", () => {
        const change = jest.fn();
        render(<InstructionsCard agent={agent} canEdit onChange={change} />);
        fireEvent.click(
            screen.getByRole("button", { name: "When risk is found" }),
        );
        expect(change.mock.calls[0][0](agent)).toEqual({
            ...agent,
            runWhen: "risk-found",
        });
    });

    it("shows the risk requirement and keeps inherited settings read-only", () => {
        render(
            <InstructionsCard
                agent={{ ...agent, runWhen: "risk-found" }}
                canEdit={false}
                onChange={jest.fn()}
            />,
        );
        expect(
            screen.getByText(
                "Requires confirmed PR risk. Manual commands still run.",
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "When risk is found" }),
        ).toBeDisabled();
    });
    it("shows a name error inline and marks the field invalid", () => {
        render(
            <InstructionsCard
                agent={agent}
                canEdit
                onChange={jest.fn()}
                nameError='Another agent, "Ledger Reviewer", already answers to @kody -v ledger-reviewer. Choose a different name.'
            />,
        );
        expect(screen.getByRole("alert")).toHaveTextContent(
            "already answers to @kody -v ledger-reviewer",
        );
        expect(screen.getByLabelText("Name")).toHaveAttribute(
            "aria-invalid",
            "true",
        );
    });

    it("shows no error when the name is free", () => {
        render(<InstructionsCard agent={agent} canEdit onChange={jest.fn()} />);
        expect(screen.queryByRole("alert")).toBeNull();
    });
});

const renderFiles = (scope: CustomAgent["scope"]) =>
    render(
        <FilesAndKnowledge
            agent={{ ...agent, scope }}
            knowledge={[]}
            canEdit
            onChange={jest.fn()}
            onKnowledgeChange={jest.fn()}
            skillsHref="/settings/code-review/repo-1/skills"
        />,
    );

describe("FilesAndKnowledge", () => {
    it("explains that brackets and parentheses also match literally", () => {
        renderFiles({ include: ["src/app/(shop)/[id]/**"] });
        expect(screen.getByRole("note")).toHaveTextContent(
            "src/app/(shop)/[id]/**",
        );
        expect(screen.getByRole("note")).toHaveTextContent(/literal/i);
    });

    it("shows no note for plain globs", () => {
        renderFiles({ include: ["src/**"], exclude: ["**/*.spec.ts"] });
        expect(screen.queryByRole("note")).toBeNull();
    });
});

describe("CommentsAndModel", () => {
    it("shows model names, never raw ids", async () => {
        (getBYOK as jest.Mock).mockResolvedValue({
            models: [
                {
                    id: "m-flash",
                    credentialId: "c1",
                    model: "accounts/fireworks/models/glm-5p3-flash",
                },
            ],
            routing: { defaultModelId: "m-flash" },
        });
        render(
            <QueryClientProvider client={new QueryClient()}>
                <CommentsAndModel agent={agent} canEdit onChange={jest.fn()} />
            </QueryClientProvider>,
        );
        await waitFor(() =>
            expect(
                screen.getByRole("combobox", { name: "Model" }),
            ).toHaveTextContent("Routing default · GLM 5.3 Flash"),
        );
        expect(screen.queryByText(/accounts\/fireworks/)).toBeNull();
    });

    it("tells apart a pin, its alias, and one id on two connections", async () => {
        (getBYOK as jest.Mock).mockResolvedValue({
            credentials: [
                { id: "c-openai", provider: "openai" },
                { id: "c-openrouter", provider: "openrouter" },
                { id: "c-env", provider: "openai", managed: true },
            ],
            models: [
                { id: "m-openai", credentialId: "c-openai", model: "gpt-5.4" },
                {
                    id: "m-openrouter",
                    credentialId: "c-openrouter",
                    model: "gpt-5.4",
                },
                // The Kodus default runs the same id; Routing leaves it out of
                // the comparison, so the pin's label must not change for it.
                {
                    id: "m-env",
                    credentialId: "c-env",
                    model: "gpt-5.4-2026-03-05",
                },
                {
                    id: "m-pin",
                    credentialId: "c-openai",
                    model: "gpt-5.4-2026-03-05",
                },
            ],
            routing: { defaultModelId: "m-pin" },
        });
        render(
            <QueryClientProvider client={new QueryClient()}>
                <CommentsAndModel agent={agent} canEdit onChange={jest.fn()} />
            </QueryClientProvider>,
        );
        const trigger = screen.getByRole("combobox", { name: "Model" });
        await waitFor(() =>
            expect(trigger).toHaveTextContent(
                "Routing default · GPT 5.4 (gpt-5.4-2026-03-05)",
            ),
        );
        // Radix Select scrolls the picked option into view; jsdom has no layout.
        Element.prototype.scrollIntoView = jest.fn();
        fireEvent.click(trigger);
        const options = (await screen.findAllByRole("option")).map(
            (o) => o.textContent,
        );
        expect(new Set(options).size).toBe(options.length);
        expect(options).toContain("GPT 5.4 (gpt-5.4-2026-03-05)");
    });
});
