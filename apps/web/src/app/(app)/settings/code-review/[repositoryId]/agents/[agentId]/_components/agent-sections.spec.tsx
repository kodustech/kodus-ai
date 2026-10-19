/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { CustomAgent } from "@services/custom-agents/types";
import { fireEvent, render, screen } from "@testing-library/react";

import { RunsOn, WhatItDoes } from "./agent-sections";

jest.mock("@services/organizationParameters/fetch", () => ({
    getBYOK: jest.fn(),
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

describe("WhatItDoes", () => {
    it("shows a name error inline and marks the field invalid", () => {
        render(
            <WhatItDoes
                agent={agent}
                knowledge={[]}
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
        render(
            <WhatItDoes
                agent={agent}
                knowledge={[]}
                canEdit
                onChange={jest.fn()}
            />,
        );
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("keeps an agent to its instructions until the team asks for general bugs", () => {
        const onChange = jest.fn();
        render(
            <WhatItDoes
                agent={agent}
                knowledge={[]}
                canEdit
                onChange={onChange}
            />,
        );
        const toggle = screen.getByRole("switch", {
            name: /also report general bugs/i,
        });
        expect(toggle).not.toBeChecked();

        fireEvent.click(toggle);

        const patch = onChange.mock.calls[0][0] as (
            a: CustomAgent,
        ) => CustomAgent;
        expect(patch(agent).reportGeneralBugs).toBe(true);
        expect(
            patch({ ...agent, reportGeneralBugs: true }).instructions,
        ).toBe(agent.instructions);
    });

    it("shows the setting on for an agent that reports general bugs", () => {
        render(
            <WhatItDoes
                agent={{ ...agent, reportGeneralBugs: true }}
                knowledge={[]}
                canEdit
                onChange={jest.fn()}
            />,
        );
        expect(
            screen.getByRole("switch", { name: /also report general bugs/i }),
        ).toBeChecked();
    });
});

describe("RunsOn", () => {
    it("explains that brackets and parentheses also match literally", () => {
        render(
            <RunsOn
                agent={{
                    ...agent,
                    scope: { include: ["src/app/(shop)/[id]/**"] },
                }}
                canEdit
                onChange={jest.fn()}
            />,
        );
        expect(screen.getByRole("note")).toHaveTextContent(
            "src/app/(shop)/[id]/**",
        );
        expect(screen.getByRole("note")).toHaveTextContent(/literal/i);
    });

    it("shows no note for plain globs", () => {
        render(
            <RunsOn
                agent={{
                    ...agent,
                    scope: { include: ["src/**"], exclude: ["**/*.spec.ts"] },
                }}
                canEdit
                onChange={jest.fn()}
            />,
        );
        expect(screen.queryByRole("note")).toBeNull();
    });
});
