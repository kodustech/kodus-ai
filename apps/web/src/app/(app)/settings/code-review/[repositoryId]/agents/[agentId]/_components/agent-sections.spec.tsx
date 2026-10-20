/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { CustomAgent } from "@services/custom-agents/types";
import { getBYOK } from "@services/organizationParameters/fetch";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";

import {
    CommentsAndModel,
    FilesAndKnowledge,
    InstructionsCard,
} from "./agent-sections";

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
    it("names the globs 'Files' and links the skills & docs page", () => {
        renderFiles({});
        expect(screen.getByLabelText("Files")).toBeInTheDocument();
        expect(screen.queryByText("Runs on")).toBeNull();
        expect(screen.queryByText("Follows")).toBeNull();
        expect(
            screen.getByRole("link", { name: "Manage skills & docs" }),
        ).toHaveAttribute("href", "/settings/code-review/repo-1/skills");
    });

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
            ).toHaveTextContent("Routing default (GLM 5.3 Flash)"),
        );
        expect(screen.queryByText(/accounts\/fireworks/)).toBeNull();
    });
});
