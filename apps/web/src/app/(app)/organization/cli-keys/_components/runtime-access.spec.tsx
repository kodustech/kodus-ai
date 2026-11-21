/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen } from "@testing-library/react";

import {
    repositoriesToSave,
    RuntimeAccess,
    sameRepositories,
    usesRuntimeRepositories,
    type RuntimeAccessDraft,
} from "./runtime-access";

const repo = (id: string, name: string) => ({
    id,
    name,
    full_name: `acme/${name}`,
    organizationName: "acme",
});
const REPOS = [repo("r1", "api"), repo("r2", "web"), repo("r3", "cli")];

const setup = (draft: RuntimeAccessDraft) => {
    const onChange = jest.fn();
    render(
        <RuntimeAccess
            repositories={REPOS}
            draft={draft}
            onChange={onChange}
        />,
    );
    return onChange;
};

describe("RuntimeAccess", () => {
    it("shows the repositories only once Runs reading is on, and turning it on keeps the list", () => {
        const onChange = setup({ runsRead: false, repositoryIds: ["r2"] });
        expect(
            screen.queryByLabelText("Repositories the key reaches"),
        ).not.toBeInTheDocument();
        fireEvent.click(
            screen.getByRole("switch", { name: "Read Kody Runtime Runs" }),
        );
        expect(onChange).toHaveBeenCalledWith({
            runsRead: true,
            repositoryIds: ["r2"],
        });
    });

    it("adds and removes a repository, and selects all or none", () => {
        const onChange = setup({ runsRead: true, repositoryIds: ["r2"] });
        expect(screen.getByText("1 of 3 repositories")).toBeInTheDocument();

        fireEvent.click(screen.getByLabelText("acme/api"));
        expect(onChange).toHaveBeenLastCalledWith({
            runsRead: true,
            repositoryIds: ["r2", "r1"],
        });
        fireEvent.click(screen.getByLabelText("acme/web"));
        expect(onChange).toHaveBeenLastCalledWith({
            runsRead: true,
            repositoryIds: [],
        });
        fireEvent.click(screen.getByRole("button", { name: "Select all" }));
        expect(onChange).toHaveBeenLastCalledWith({
            runsRead: true,
            repositoryIds: ["r1", "r2", "r3"],
        });
        fireEvent.click(screen.getByRole("button", { name: "Clear" }));
        expect(onChange).toHaveBeenLastCalledWith({
            runsRead: true,
            repositoryIds: [],
        });
    });

    it("warns that no repository means no Runs, and names the ones the team no longer has", () => {
        setup({ runsRead: true, repositoryIds: ["gone"] });
        expect(screen.getByText("0 of 3 repositories")).toBeInTheDocument();
        expect(screen.getByText(/the key reads no Runs/)).toBeInTheDocument();
        expect(
            screen.getByText(
                /1 repository on this key is no longer configured/,
            ),
        ).toBeInTheDocument();
    });
});

describe("RuntimeAccess environment capabilities", () => {
    it("switches env:exec and env:fix on their own, keeping the rest of the draft", () => {
        const onChange = setup({ runsRead: false, repositoryIds: ["r1"] });
        fireEvent.click(
            screen.getByRole("switch", {
                name: "Run commands in Kody Runtime environments",
            }),
        );
        expect(onChange).toHaveBeenLastCalledWith({
            runsRead: false,
            envExec: true,
            repositoryIds: ["r1"],
        });
        fireEvent.click(
            screen.getByRole("switch", {
                name: "Fix blocked Kody Runtime environments",
            }),
        );
        expect(onChange).toHaveBeenLastCalledWith({
            runsRead: false,
            envFix: true,
            repositoryIds: ["r1"],
        });
    });

    it("shows the repositories for env:exec alone, since it also reaches only them", () => {
        setup({ runsRead: false, envExec: true, repositoryIds: [] });
        expect(
            screen.getByLabelText("Repositories the key reaches"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/the key reaches no environment/),
        ).toBeInTheDocument();
    });

    it("any Runtime capability makes the list matter", () => {
        expect(
            usesRuntimeRepositories({ runsRead: false, repositoryIds: [] }),
        ).toBe(false);
        expect(
            usesRuntimeRepositories({
                runsRead: false,
                envFix: true,
                repositoryIds: [],
            }),
        ).toBe(true);
    });
});

describe("repositoriesToSave", () => {
    it("keeps only the repositories the team still has, in the team's order", () => {
        expect(repositoriesToSave(["r3", "gone", "r1"], REPOS)).toEqual([
            "r1",
            "r3",
        ]);
    });

    it("compares lists without caring about order", () => {
        expect(sameRepositories(["r1", "r3"], ["r3", "r1"])).toBe(true);
        expect(sameRepositories(["r1"], undefined)).toBe(false);
        expect(sameRepositories([], undefined)).toBe(true);
    });
});

describe("RuntimeAccess external finding capability", () => {
    it("lets a key submit findings without implicitly granting shell execution", () => {
        const onChange = setup({ runsRead: false, repositoryIds: ["r1"] });
        fireEvent.click(
            screen.getByRole("switch", {
                name: "Submit findings from external agents",
            }),
        );
        expect(onChange).toHaveBeenLastCalledWith({
            runsRead: false,
            findingsSubmit: true,
            repositoryIds: ["r1"],
        });
    });

    it("requires repository scope for a findings-only key", () => {
        setup({ runsRead: false, findingsSubmit: true, repositoryIds: [] });
        expect(
            usesRuntimeRepositories({
                runsRead: false,
                findingsSubmit: true,
                repositoryIds: [],
            }),
        ).toBe(true);
        expect(
            screen.getByLabelText("Repositories the key reaches"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/the key submits no findings/),
        ).toBeInTheDocument();
    });
});
