/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { CustomAgentTryTrace } from "@services/custom-agents/types";
import { createAgentFromTemplate } from "@services/custom-agents/drafts";
import { useTryCustomAgent } from "@services/custom-agents/hooks";
import { fireEvent, render, screen } from "@testing-library/react";

import { TryIt, TryResult } from "./try-it";

jest.mock("@services/custom-agents/hooks", () => ({
    useTryCustomAgent: jest.fn(),
}));

const trace = (
    over: Partial<CustomAgentTryTrace> = {},
): CustomAgentTryTrace => ({
    status: "completed",
    skillsOpened: [],
    toolCalls: [],
    findings: [],
    ...over,
});

describe("TryResult", () => {
    it("shows what the run lost, as a review reports it", () => {
        render(
            <TryResult
                trace={trace({
                    warnings: [
                        {
                            kind: "CLI_INSTALL_FAILED",
                            detail: 'Ledger reviewer: CLI "dupfinder" unavailable (install failed); the agent ran without it',
                        },
                        {
                            kind: "SKILL_NOT_FOUND",
                            detail: ".skills/ledger-posting: no SKILL.md on main",
                        },
                    ],
                })}
            />,
        );

        expect(screen.getByText("Warnings")).toBeInTheDocument();
        expect(
            screen.getByText(/CLI "dupfinder" unavailable/),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/\.skills\/ledger-posting: no SKILL\.md on main/),
        ).toBeInTheDocument();
    });

    it("shows the comment a kept finding would post and why a dropped one fell", () => {
        render(
            <TryResult
                trace={trace({
                    findings: [
                        {
                            file: "src/billing/refund.ts",
                            summary: "Refund repeats the charge parser",
                            verdict: "kept",
                            wouldPost: true,
                            comment: "The parser is copied from charge.ts.",
                        },
                        {
                            file: "src/billing/void.ts",
                            summary: "Void repeats the charge parser",
                            body: "Void copies the parser too.",
                            verdict: "dropped",
                            reason: "src/billing/void.ts is not a guide linked to this review",
                            wouldPost: false,
                        },
                    ],
                })}
            />,
        );

        expect(
            screen.getByText("The parser is copied from charge.ts."),
        ).toBeInTheDocument();
        expect(screen.getByText("Void copies the parser too.")).toBeInTheDocument();
        expect(
            screen.getByText(/is not a guide linked to this review/),
        ).toBeInTheDocument();
    });

    it("shows the warnings of a failed run too", () => {
        render(
            <TryResult
                trace={trace({
                    status: "failed",
                    reason: "model refused the key",
                    warnings: [{ kind: "SANDBOX_UNAVAILABLE" }],
                })}
            />,
        );

        expect(
            screen.getByText(/SANDBOX_UNAVAILABLE|read only the diff/),
        ).toBeInTheDocument();
    });

    it("shows no warnings section when the run lost nothing", () => {
        render(<TryResult trace={trace()} />);

        expect(screen.queryByText("Warnings")).not.toBeInTheDocument();
    });
});

describe("TryIt", () => {
    const STALE = /from an earlier version of the agent/;

    it("says the result belongs to an earlier agent after an edit, and not once it is back", () => {
        (useTryCustomAgent as jest.Mock).mockReturnValue({
            data: trace(),
            isPending: false,
            isError: false,
            mutate: jest.fn(),
            reset: jest.fn(),
        });
        const agent = createAgentFromTemplate("blank", []);
        const props = {
            teamId: "team",
            repositoryId: "repo",
            knowledge: [],
            canEdit: true,
        };
        const { rerender } = render(<TryIt {...props} agent={agent} />);
        fireEvent.change(screen.getByPlaceholderText("Pull request link"), {
            target: { value: "https://github.com/acme/ledger/pull/7" },
        });
        fireEvent.click(screen.getByText("Run agent"));
        expect(screen.queryByText(STALE)).not.toBeInTheDocument();

        rerender(
            <TryIt
                {...props}
                agent={{ ...agent, instructions: "Temporary instructions." }}
            />,
        );
        expect(screen.getByText(STALE)).toBeInTheDocument();

        // Reset puts the original agent back on screen.
        rerender(<TryIt {...props} agent={agent} />);
        expect(screen.queryByText(STALE)).not.toBeInTheDocument();
    });

    it("offers no pull request field at the global level, only where to try it", () => {
        (useTryCustomAgent as jest.Mock).mockReturnValue({
            isPending: false,
            isError: false,
            mutate: jest.fn(),
            reset: jest.fn(),
        });
        render(
            <TryIt
                teamId="team"
                repositoryId="global"
                knowledge={[]}
                canEdit
                agent={createAgentFromTemplate("blank", [])}
            />,
        );
        expect(screen.queryByPlaceholderText("Pull request link")).toBeNull();
        expect(screen.queryByText("Run agent")).toBeNull();
        expect(
            screen.getByText(/Open a repository's settings to try the agent/),
        ).toBeInTheDocument();
    });
});
