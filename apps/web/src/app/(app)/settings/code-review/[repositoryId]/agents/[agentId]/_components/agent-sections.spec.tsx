/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { CustomAgent } from "@services/custom-agents/types";
import { render, screen } from "@testing-library/react";

import { WhatItDoes } from "./agent-sections";

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
});
