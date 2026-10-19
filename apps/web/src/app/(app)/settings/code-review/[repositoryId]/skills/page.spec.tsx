/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { toast } from "@components/ui/toaster/use-toast";
import type { CustomAgent, KnowledgeItem } from "@services/custom-agents/types";
import { act, fireEvent, render, screen } from "@testing-library/react";

import SkillsAndDocsPage from "./page";

const agent = (id: string, name: string): CustomAgent => ({
    id,
    name,
    enabled: true,
    instructions: "Every reading is calibrated.",
    scope: {},
    tools: {},
    presentation: {
        tag: { color: "#6366f1" },
        format: "inline",
        suggestedFix: "when-confident",
    },
});

const valves = agent("valves", "Valves reviewer");
const drip = agent("drip", "Drip reviewer");
const doc: KnowledgeItem = {
    path: "docs/irrigation.md",
    kind: "doc",
    linkedTo: [],
};
const setKnowledge = jest.fn();
const save = jest.fn();
let mockReport: unknown;
let mockCustomAgents = true;
const resolveCustomAgent = jest.fn();

jest.mock("../_custom-agents/use-custom-agents-form", () => ({
    reviewScopeHref: () => "/settings/code-review/repo-1/review-scope",
    // A directory: it owns the drip agent and also runs the repository's
    // valves agent.
    useCustomAgentsForm: () => ({
        teamId: "team-1",
        repositoryId: "repo-1",
        directoryId: "dir-1",
        agents: [drip],
        linkableAgents: [valves, drip],
        knowledge: [doc],
        // The doc link this save keeps is unsaved.
        isDirty: mockReport !== undefined,
        isSubmitting: false,
        setKnowledge,
        save,
        reset: jest.fn(),
    }),
}));

jest.mock("@services/custom-agents/hooks", () => ({
    useResolveCustomAgent: (params: unknown) => {
        resolveCustomAgent(params);
        return { isLoading: false, data: mockReport };
    },
}));

jest.mock("@services/permissions/hooks", () => ({
    usePermission: () => true,
}));

jest.mock("../../../_components/context", () => ({
    useFeatureFlags: () => ({ customAgents: mockCustomAgents }),
}));

jest.mock("src/core/hooks/use-unsaved-changes-guard", () => ({
    useUnsavedChangesGuard: jest.fn(),
}));

jest.mock("../../_components/centralized-config-readonly-alert", () => ({
    CentralizedConfigReadOnlyAlert: () => null,
}));

jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

describe("Skills & docs page at a directory", () => {
    it("links a doc to an agent the directory inherits from the repository", () => {
        render(<SkillsAndDocsPage />);

        fireEvent.click(
            screen.getByRole("checkbox", {
                name: "docs/irrigation.md for Valves reviewer",
            }),
        );

        expect(setKnowledge).toHaveBeenCalledWith([
            { ...doc, linkedTo: [{ agentId: "valves" }] },
        ]);
    });
});

describe("Skills & docs page without the custom agents flag", () => {
    beforeEach(() => {
        mockCustomAgents = false;
        resolveCustomAgent.mockClear();
    });
    afterEach(() => {
        mockCustomAgents = true;
    });

    it("shows no linking or save controls and reads nothing from the repository", () => {
        render(<SkillsAndDocsPage />);

        expect(screen.queryByRole("checkbox")).toBeNull();
        expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
        expect(resolveCustomAgent).toHaveBeenCalledWith(
            expect.objectContaining({ enabled: false }),
        );
    });
});

describe("Skills & docs page over a limit", () => {
    // The docs linked to the inherited valves agent are over the token
    // budget, which only reading them on the branch can tell: the save
    // keeps them, and a review cuts them to the budget.
    beforeEach(() => {
        mockReport = {
            repository: { branch: "main" },
            knowledge: {
                status: "ok",
                items: [],
                candidates: [],
                budgets: [
                    {
                        target: "agent:valves",
                        skills: 0,
                        docs: 1,
                        docTokens: 23900,
                        over: ["docTokens"],
                    },
                ],
            },
        };
        save.mockReset();
        save.mockResolvedValue({});
        (toast as jest.Mock).mockClear();
    });
    afterEach(() => {
        mockReport = undefined;
    });

    it("names the agent, not its internal id", () => {
        render(<SkillsAndDocsPage />);

        expect(
            screen.getByText(
                /^Valves reviewer is over its limit \(doc tokens\)/,
            ),
        ).toBeInTheDocument();
        expect(screen.queryByText(/agent:valves/)).toBeNull();
    });

    it("says the save kept an agent over its limit instead of only saved", async () => {
        render(<SkillsAndDocsPage />);
        fireEvent.click(screen.getByRole("button", { name: /save/i }));
        await act(async () => {});

        expect(toast).toHaveBeenCalledWith(
            expect.objectContaining({
                variant: "warning",
                description: expect.stringMatching(
                    /^Saved\. Valves reviewer is over its limit \(doc tokens\)/,
                ),
            }),
        );
        expect(toast).not.toHaveBeenCalledWith(
            expect.objectContaining({ description: "Settings saved" }),
        );
    });
});
