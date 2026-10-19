/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { useState } from "react";
import { CLI_SECRET_MASK, newCliTool } from "@services/custom-agents/drafts";
import type { CustomAgent } from "@services/custom-agents/types";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { ClisField } from "./tools-card";

const agent: CustomAgent = {
    id: "ledger",
    name: "Ledger reviewer",
    enabled: true,
    instructions: "Every posting must balance.",
    scope: {},
    tools: {
        cli: [
            {
                ...newCliTool(),
                name: "semver",
                binary: "semver-cli",
                install: "npm i -g semver@7.6.0",
            },
        ],
    },
    presentation: {
        tag: { color: "#6366f1" },
        format: "inline",
        suggestedFix: "when-confident",
    },
};

/** Holds the agent like the page's form does. */
const Harness = ({ initial = agent }: { initial?: CustomAgent }) => {
    const [current, setCurrent] = useState(initial);
    return (
        <>
            <ClisField
                agent={current}
                canEdit
                onChange={(patch) => setCurrent(patch)}
            />
            <span data-testid="secrets">
                {JSON.stringify(current.tools.cli?.[0]?.secrets ?? [])}
            </span>
            <span data-testid="names">
                {(current.tools.cli ?? []).map((cli) => cli.name).join(",")}
            </span>
        </>
    );
};

describe("ClisField", () => {
    it("lists each CLI as a compact row, without its form", () => {
        render(<Harness />);
        const row = screen.getByRole("listitem");
        expect(row).toHaveTextContent("semver · semver-cli");
        expect(
            within(row).getByRole("button", { name: "Edit semver" }),
        ).toBeInTheDocument();
        expect(screen.getByText("npm i -g semver@7.6.0")).toBeInTheDocument();
        expect(screen.queryByLabelText("Install")).toBeNull();
    });

    it("opens the CLI's full form in a side sheet and edits it there", () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole("button", { name: "Edit semver" }));

        const sheet = screen.getByRole("dialog");
        expect(within(sheet).getByLabelText("Install")).toHaveValue(
            "npm i -g semver@7.6.0",
        );
        fireEvent.change(within(sheet).getByLabelText("Name"), {
            target: { value: "semver2" },
        });
        expect(screen.getByTestId("names")).toHaveTextContent("semver2");
    });

    it.each([
        ["Install", "npm i -g semver-fork@1.0.0"],
        ["Binary", "node"],
    ])("asks for a stored secret again when the %s changes", (label, value) => {
        const withSecret: CustomAgent = {
            ...agent,
            tools: {
                cli: [
                    {
                        ...agent.tools.cli![0],
                        secrets: [
                            { env: "NPM_TOKEN", ciphertext: CLI_SECRET_MASK },
                        ],
                    },
                ],
            },
        };
        render(<Harness initial={withSecret} />);
        fireEvent.click(screen.getByRole("button", { name: "Edit semver" }));
        const sheet = screen.getByRole("dialog");
        expect(within(sheet).getByText("Stored · hidden")).toBeInTheDocument();

        fireEvent.change(within(sheet).getByLabelText(label), {
            target: { value },
        });

        expect(within(sheet).queryByText("Stored · hidden")).toBeNull();
        expect(
            within(sheet).getByPlaceholderText("Value (write-only)"),
        ).toHaveValue("");
        expect(screen.getByTestId("secrets")).toHaveTextContent(
            JSON.stringify([{ env: "NPM_TOKEN", value: "" }]),
        );
    });

    it("keeps a stored secret when the name or usage change", () => {
        const withSecret: CustomAgent = {
            ...agent,
            tools: {
                cli: [
                    {
                        ...agent.tools.cli![0],
                        secrets: [
                            { env: "NPM_TOKEN", ciphertext: CLI_SECRET_MASK },
                        ],
                    },
                ],
            },
        };
        render(<Harness initial={withSecret} />);
        fireEvent.click(screen.getByRole("button", { name: "Edit semver" }));
        fireEvent.change(
            within(screen.getByRole("dialog")).getByLabelText("Name"),
            { target: { value: "semver2" } },
        );
        expect(
            within(screen.getByRole("dialog")).getByText("Stored · hidden"),
        ).toBeInTheDocument();
    });

    it("removes a CLI from its row", () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole("button", { name: "Remove semver" }));
        expect(screen.getByTestId("names")).toHaveTextContent("");
        expect(screen.queryByText("npm i -g semver@7.6.0")).toBeNull();
    });

    it("opens a new CLI in the sheet", () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole("button", { name: "Add CLI" }));
        expect(
            within(screen.getByRole("dialog")).getByText("New CLI"),
        ).toBeInTheDocument();
    });
});
