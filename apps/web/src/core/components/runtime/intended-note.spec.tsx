/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";

import { IntendedNote } from "./intended-note";

// demo-nextjs#2: the PR rewords one feature line on purpose.
const CHANGE = {
    field: "step.2.value",
    base: "Production-ready configuration",
    pr: "Production configuration, ready to deploy",
    file: "examples/with-docker/app/page.tsx",
    line: 35,
};
const HEAD = "1b0ad40ef4aefcdc2547c7bb918be95121f442c0";
const pr = { side: "pr" as const, sha: HEAD, rounds: [], answer: "2/4", steady: true };

describe("IntendedNote", () => {
    it("shows the two values the diff swaps and the added line, linked at the PR's head", () => {
        render(
            <IntendedNote
                finding={{ intendedBy: "diff", intendedChange: [CHANGE], pr }}
                pullRequestUrl="https://github.com/example-org/demo-nextjs/pull/2"
            />,
        );
        const note = screen.getByRole("note");
        expect(note).toHaveTextContent("this PR's diff changes exactly these values");
        expect(note).toHaveTextContent(
            "Production-ready configuration on main → Production configuration, ready to deploy on this PR · examples/with-docker/app/page.tsx:35",
        );
        expect(screen.getByRole("link", { name: "examples/with-docker/app/page.tsx:35" })).toHaveAttribute(
            "href",
            `https://github.com/example-org/demo-nextjs/blob/${HEAD}/examples/with-docker/app/page.tsx#L35`,
        );
    });

    it("without a link to the PR, names the line as text", () => {
        render(<IntendedNote finding={{ intendedBy: "diff", intendedChange: [CHANGE], pr }} />);
        expect(screen.getByRole("note")).toHaveTextContent("examples/with-docker/app/page.tsx:35");
        expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("an intended change a pre-existing test backs says so, and shows no values", () => {
        render(<IntendedNote finding={{ intendedBy: "test", pr }} />);
        const note = screen.getByRole("note");
        expect(note).toHaveTextContent("a test that already existed on main expects it");
        expect(note).not.toHaveTextContent("on main →");
    });
});
