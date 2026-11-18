/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen } from "@testing-library/react";

import { AgentPromptHint } from "./agent-prompt-hint";

describe("AgentPromptHint", () => {
    beforeAll(() => {
        if (!("ResizeObserver" in globalThis)) {
            (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
                class {
                    observe() {}
                    unobserve() {}
                    disconnect() {}
                };
        }
    });

    it("shows the prompt for a coding agent before it is copied", async () => {
        render(<AgentPromptHint />);
        fireEvent.click(
            screen.getByRole("button", {
                name: /Get a prompt for Claude Code, Cursor or Codex/,
            }),
        );
        expect(await screen.findByLabelText("Prompt")).toHaveTextContent(
            "Write .kodus/workspace.yaml for this repository",
        );
        // A repository that already has .kodus/workspace.yaml for Runo (Kodus's
        // own) gets the file the Runtime reads first, not an edit of Runo's.
        expect(screen.getByLabelText("Prompt")).toHaveTextContent(
            "If .kodus/workspace.yaml already exists for another tool, write .kodus/workspace.runtime.yaml instead",
        );
        expect(
            screen.getByRole("button", { name: "Copy prompt" }),
        ).toBeInTheDocument();
    });
});
