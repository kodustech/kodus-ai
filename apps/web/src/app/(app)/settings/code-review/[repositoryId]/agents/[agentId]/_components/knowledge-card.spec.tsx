/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { KnowledgeItemReport } from "@services/custom-agents/types";
import { render, screen } from "@testing-library/react";

import { KnowledgeIssues } from "./knowledge-card";

const report = (issues: KnowledgeItemReport["issues"]): KnowledgeItemReport =>
    ({
        path: "skills/money/SKILL.md",
        kind: "skill",
        found: true,
        issues,
        linkedTo: [],
    }) as KnowledgeItemReport;

describe("KnowledgeIssues", () => {
    it("shows the text of each warning and error, not only their count", () => {
        render(
            <KnowledgeIssues
                report={report([
                    {
                        severity: "warning",
                        message:
                            "SKILL.md body truncated to 500 lines / ~5000 tokens",
                    },
                    { severity: "error", message: "name is missing" },
                ])}
            />,
        );
        expect(
            screen.getByText(
                "SKILL.md body truncated to 500 lines / ~5000 tokens",
            ),
        ).toBeInTheDocument();
        expect(screen.getByText("name is missing")).toBeInTheDocument();
    });

    it("renders nothing without issues", () => {
        const { container } = render(<KnowledgeIssues report={report([])} />);
        expect(container).toBeEmptyDOMElement();
    });
});
