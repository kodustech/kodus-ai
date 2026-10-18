/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { CustomAgentTryTrace } from "@services/custom-agents/types";
import { render, screen } from "@testing-library/react";

import { TryResult } from "./try-it";

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
