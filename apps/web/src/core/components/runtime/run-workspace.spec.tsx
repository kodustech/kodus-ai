/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { workspaceSideRows } from "@services/runtime/model/environment-repositories";
import { render, screen, within } from "@testing-library/react";

import { RunWorkspaceSection } from "./run-workspace";

const sha = (c: string) => c.repeat(40);
const rows = workspaceSideRows(
    {
        prNumber: 482,
        baseBranch: "main",
        workspace: [
            {
                repositoryId: "r-app",
                alias: "app",
                baseSha: sha("7"),
                headSha: sha("e"),
                source: "pull_request",
            },
            {
                repositoryId: "r-billing",
                alias: "billing",
                baseSha: sha("9"),
                headSha: sha("9"),
                source: "default_branch",
                branch: "main",
            },
        ],
    },
    new Map([["r-app", "app"]]),
);

describe("What ran on each side", () => {
    it("shows each repository's commit on both sides and why", () => {
        render(
            <RunWorkspaceSection
                rows={rows}
                pullRequestBranch="feat/invoice-rounding"
            />,
        );
        const section = screen.getByRole("region", {
            name: "What ran on each side",
        });
        const body = within(section).getAllByRole("row").slice(1);
        // The PR's repository: main's commit, then the PR's.
        for (const fact of ["ws/app", "7777777", "eeeeeee", "#482"])
            expect(body[0]).toHaveTextContent(fact);
        // Another repository: the same default-branch commit on both sides.
        expect(body[1]).toHaveTextContent("ws/billing");
        expect(body[1].textContent?.match(/9999999/g)).toHaveLength(2);
        expect(section).toHaveTextContent("feat/invoice-rounding");
    });

    it("is nothing for a Run of one repository", () => {
        const { container } = render(<RunWorkspaceSection rows={[]} />);
        expect(container).toBeEmptyDOMElement();
    });
});
