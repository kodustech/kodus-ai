/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { CustomAgent, KnowledgeItem } from "@services/custom-agents/types";
import { fireEvent, render, screen } from "@testing-library/react";

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
        isDirty: false,
        isSubmitting: false,
        setKnowledge,
        save: jest.fn(),
        reset: jest.fn(),
    }),
}));

jest.mock("@services/custom-agents/hooks", () => ({
    useResolveCustomAgent: () => ({ isLoading: false, data: undefined }),
}));

jest.mock("@services/permissions/hooks", () => ({
    usePermission: () => true,
}));

const TRIAL = { valid: true, subscriptionStatus: "trial", planType: "teams_managed" };
let mockLicense: Record<string, unknown> = TRIAL;
jest.mock("src/features/ee/subscription/_providers/subscription-context", () => ({
    useSubscriptionContext: () => ({ license: mockLicense }),
}));

jest.mock("src/core/utils/gate-hit", () => ({
    captureGateHit: jest.fn(),
    captureGateCtaClick: jest.fn(),
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

describe("Skills & docs page on free", () => {
    afterEach(() => {
        mockLicense = TRIAL;
    });

    it("is locked with the upgrade card and lists none of the docs", () => {
        mockLicense = {
            valid: true,
            subscriptionStatus: "active",
            planType: "free_byok",
        };
        render(<SkillsAndDocsPage />);

        expect(
            screen.getByRole("heading", { name: "Unlock custom agents" }),
        ).toBeInTheDocument();
        expect(screen.queryByText("docs/irrigation.md")).toBeNull();
    });
});
