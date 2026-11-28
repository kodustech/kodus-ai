/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import type { BlockerGroup } from "@services/runtime/contracts";
import {
    useAddEnvironmentRepository,
    useApplyBlockerFix,
} from "@services/runtime/queries";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { BlockerCard, fixButtonLabel, learnedLabel } from "./blocker-card";

jest.mock("@services/runtime/queries", () => ({
    useApplyBlockerFix: jest.fn(),
    useAddEnvironmentRepository: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));
jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ children, href }: { children: ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

const mutate = jest.fn();
beforeEach(() => {
    mutate.mockReset();
    (useApplyBlockerFix as jest.Mock).mockReturnValue({
        mutate,
        isPending: false,
    });
});

const GROUP: BlockerGroup = {
    signature: "missing_env:STRIPE_SECRET_KEY",
    kind: "missing_env",
    title: "The app needs STRIPE_SECRET_KEY, which the environment doesn't set",
    count: 3,
    lastAt: "2026-11-03T12:00:00.000Z",
    lastPr: 41,
    evidence: {
        service: "api",
        lines: [
            "Error: Missing required environment variable: STRIPE_SECRET_KEY",
        ],
    },
    fixes: [
        {
            id: "set_env:STRIPE_SECRET_KEY",
            action: "set_env",
            who: "dev",
            label: "Give STRIPE_SECRET_KEY a test value in the recipe",
            recipeDiff:
                '--- a/.kodus/workspace.yaml\n+++ b/.kodus/workspace.yaml\n@@ -1,2 +1,4 @@\n   compose:\n+    env:\n+      STRIPE_SECRET_KEY: "kodus-test-value"',
        },
        {
            id: "use_mock:STRIPE_SECRET_KEY",
            action: "use_mock",
            who: "dev",
            label: "Point it at a fake service",
            detail: "Add a fake to the compose.",
        },
        {
            id: "retry_setup",
            action: "retry_setup",
            who: "one_click",
            label: "Run the setup again",
        },
    ],
};

describe("BlockerCard", () => {
    it("shows the evidence and the fixes in order, the first recommended", () => {
        render(<BlockerCard environmentId="env-1" group={GROUP} canApply />);
        expect(screen.getByText("From the api logs")).toBeInTheDocument();
        expect(
            screen.getByText(/Missing required environment variable/),
        ).toBeInTheDocument();
        const fixes = within(
            screen.getByRole("list", { name: "Fixes" }),
        ).getAllByRole("listitem");
        expect(fixes).toHaveLength(3);
        expect(within(fixes[0]).getByText("Recommended")).toBeInTheDocument();
        expect(
            within(fixes[1]).queryByText("Recommended"),
        ).not.toBeInTheDocument();
        expect(
            within(fixes[0]).getByLabelText("Setup file change").textContent,
        ).toContain('+      STRIPE_SECRET_KEY: "kodus-test-value"');
        // A fix made by hand has no button.
        expect(within(fixes[1]).queryByRole("button")).not.toBeInTheDocument();
    });

    it("opens the setup file PR and then links to it", () => {
        render(<BlockerCard environmentId="env-1" group={GROUP} canApply />);
        fireEvent.click(
            screen.getByRole("button", { name: "Open the setup file PR" }),
        );
        expect(mutate).toHaveBeenCalledWith(
            {
                environmentId: "env-1",
                signature: GROUP.signature,
                fixId: "set_env:STRIPE_SECRET_KEY",
            },
            expect.anything(),
        );
        act(() =>
            mutate.mock.calls[0][1].onSuccess({
                action: "set_env",
                pullRequest: {
                    number: 7,
                    url: "https://github.com/acme/shop/pull/7",
                },
            }),
        );
        expect(
            screen.getByRole("link", { name: /Setup file PR #7/ }),
        ).toHaveAttribute("href", "https://github.com/acme/shop/pull/7");
        expect(
            screen.queryByRole("button", { name: "Open the setup file PR" }),
        ).not.toBeInTheDocument();
    });

    it("runs a one-click fix, and shows but disables fixes to a viewer who cannot manage the environment", () => {
        const { rerender } = render(
            <BlockerCard environmentId="env-1" group={GROUP} canApply />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Run the setup again" }),
        );
        expect(mutate).toHaveBeenCalledWith(
            expect.objectContaining({ fixId: "retry_setup" }),
            expect.anything(),
        );
        rerender(
            <BlockerCard
                environmentId="env-1"
                group={GROUP}
                canApply={false}
            />,
        );
        expect(
            screen.getByRole("button", { name: "Run the setup again" }),
        ).toBeDisabled();
    });

    it("links a fix made in Kodus to its setting instead of calling it a repository change", () => {
        render(
            <BlockerCard
                environmentId="env 1"
                group={{
                    signature: "out_of_memory",
                    kind: "resources",
                    title: "The build ran out of memory (4 GB)",
                    count: 1,
                    fixes: [
                        {
                            id: "bump_machine",
                            action: "bump_machine",
                            who: "dev",
                            label: "Give the environment a larger machine",
                        },
                        {
                            id: "use_own_cell",
                            action: "use_own_cell",
                            who: "dev",
                            label: "Run it on a cell of your own",
                        },
                        {
                            id: "fix_recipe",
                            action: "fix_recipe",
                            who: "dev",
                            label: "Change the recipe",
                        },
                    ],
                }}
                canApply
            />,
        );
        const [machine, cell, recipe] = within(
            screen.getByRole("list", { name: "Fixes" }),
        ).getAllByRole("listitem");
        expect(within(machine).getByText("In Kodus")).toBeInTheDocument();
        expect(
            within(machine).getByRole("link", {
                name: "Change the machine size",
            }),
        ).toHaveAttribute("href", "/runtime/environments/env%201#machine-size");
        expect(
            within(cell).getByRole("link", { name: "Connect a host" }),
        ).toHaveAttribute("href", "/runtime/environments#cells");
        expect(
            within(recipe).getByText("In your repository"),
        ).toBeInTheDocument();
        expect(within(recipe).queryByRole("link")).not.toBeInTheDocument();
    });

    it("labels the button of a fix by what it does", () => {
        expect(
            fixButtonLabel({
                id: "a",
                action: "approve_host",
                who: "one_click",
                label: "Allow api.segment.io and set up again",
            }),
        ).toBe("Allow api.segment.io and set up again");
        expect(
            fixButtonLabel({
                id: "b",
                action: "pin_version",
                who: "dev",
                label: "Use Node 22",
            }),
        ).toBeNull();
    });

    it("lists what Kody already tried, in order, before the fixes", () => {
        render(
            <BlockerCard
                environmentId="env-1"
                group={{ ...GROUP, tried: ["Set PORT=3000: still blocked", "Wait 300 s for the ready check: booted once, then not on the second clean machine"] }}
                canApply
            />,
        );
        const list = screen.getByRole("list", { name: "Kody already tried" });
        expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
            "Set PORT=3000: still blocked",
            "Wait 300 s for the ready check: booted once, then not on the second clean machine",
        ]);
    });

    it("shows no tried list when Kody did not work on the blocker", () => {
        render(<BlockerCard environmentId="env-1" group={GROUP} canApply />);
        expect(screen.queryByRole("list", { name: "Kody already tried" })).toBeNull();
    });

    it("says where a fix worked before", () => {
        expect(
            learnedLabel({
                lessonId: "l",
                scope: "repo",
                helped: 1,
                lastAt: "x",
            }),
        ).toBe("Worked before in this repository");
        expect(
            learnedLabel({
                lessonId: "l",
                scope: "org",
                helped: 3,
                lastAt: "x",
            }),
        ).toBe("Worked before in your org (3×)");
    });
});

describe("BlockerCard about the environment's repositories", () => {
    const add = jest.fn();
    const addState = {
        mutate: add,
        isPending: false,
        isSuccess: false,
        isError: false,
        error: null as unknown,
    };
    beforeEach(() => {
        add.mockReset();
        Object.assign(addState, {
            isError: false,
            error: null,
            isSuccess: false,
        });
        (useAddEnvironmentRepository as jest.Mock).mockReturnValue(addState);
    });

    const needsMember: BlockerGroup = {
        signature: "needs_member:acme/billing",
        kind: "other_repo" as BlockerGroup["kind"],
        title: "The recipe needs acme/billing, which is not part of this environment",
        count: 1,
        fixes: [
            {
                id: "add_repository:repo-2",
                action: "add_repository",
                who: "one_click",
                label: "Add acme/billing to this environment",
                detail: "Boots it beside this repository at ws/billing.",
                repositoryId: "repo-2",
                repository: "acme/billing",
                alias: "billing",
            },
        ],
    };

    it("adds the repository the recipe needs in one click, with the folder it names", () => {
        render(
            <BlockerCard environmentId="env-1" group={needsMember} canApply />,
        );
        fireEvent.click(
            screen.getByRole("button", {
                name: "Add acme/billing to this environment",
            }),
        );
        expect(add).toHaveBeenCalledWith(
            {
                environmentId: "env-1",
                repositoryId: "repo-2",
                alias: "billing",
            },
            expect.any(Object),
        );
        expect(mutate).not.toHaveBeenCalled();
    });

    it("lets only the owner add it, and shows a refusal inline", () => {
        Object.assign(addState, {
            isError: true,
            error: {
                statusCode: 409,
                body: {
                    message:
                        "Another repository of this environment has that alias",
                },
            },
        });
        render(
            <BlockerCard
                environmentId="env-1"
                group={needsMember}
                canApply={false}
            />,
        );
        expect(
            screen.getByRole("button", {
                name: "Add acme/billing to this environment",
            }),
        ).toBeDisabled();
        expect(screen.getByRole("alert")).toHaveTextContent(
            "Another repository of this environment has that alias",
        );
    });

    it("links a repository Kodus is not connected to to the Git settings", () => {
        render(
            <BlockerCard
                environmentId="env-1"
                canApply
                group={{
                    signature: "needs_connection:acme/billing",
                    kind: "other_repo" as BlockerGroup["kind"],
                    title: "The recipe needs acme/billing, which is not connected to Kodus",
                    count: 1,
                    fixes: [
                        {
                            id: "connect_repository:acme/billing",
                            action: "connect_repository",
                            who: "settings",
                            label: "Connect acme/billing to Kodus",
                            repository: "acme/billing",
                        },
                    ],
                }}
            />,
        );
        expect(
            screen.getByRole("link", {
                name: /Connect acme\/billing to Kodus/,
            }),
        ).toHaveAttribute("href", "/settings/git/repositories");
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });
});

// docs/runtime/egress-allowlist.md §9: one click allows reads only; full access is a second step that says the risk.
describe("BlockerCard allowing a host", () => {
    const EGRESS: BlockerGroup = {
        signature: "external_service:egress:cdn.vendor.example",
        kind: "external_service",
        title: "The app tried to reach cdn.vendor.example, which isn't allowed from the machine",
        count: 1,
        lastAt: "2026-11-13T12:00:00.000Z",
        evidence: { lines: ["outbound request to cdn.vendor.example blocked"] },
        fixes: [
            {
                id: "approve_host:cdn.vendor.example",
                action: "approve_host",
                who: "one_click",
                host: "cdn.vendor.example",
                label: "Allow cdn.vendor.example and set up again",
            },
        ],
    };

    it("allows reads with one click and full access only after the risk is shown", () => {
        render(<BlockerCard environmentId="env-1" group={EGRESS} canApply />);
        expect(screen.getByText(/GET and HEAD/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Allow cdn.vendor.example and set up again" }));
        expect(mutate).toHaveBeenLastCalledWith({ environmentId: "env-1", signature: EGRESS.signature, fixId: "approve_host:cdn.vendor.example" }, expect.anything());
        expect(screen.queryByRole("button", { name: /Allow full access/ })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "It needs to send data there" }));
        expect(screen.getByRole("alert")).toHaveTextContent("an upload or a publish included");
        fireEvent.click(screen.getByRole("button", { name: "Allow full access to cdn.vendor.example" }));
        expect(mutate).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "passthrough" }), expect.anything());
    });

    // S-58: a host that answered without a credential links to Settings, Secrets with the name and host, never "allow".
    it("links a needs-a-credential card to the secret, prefilled", () => {
        const group: BlockerGroup = {
            ...EGRESS,
            signature: "external_service:credential:npm.taskforce.sh",
            title: "npm.taskforce.sh needs a credential. Your .npmrc reads it from NPM_TASKFORCESH_TOKEN",
            fixes: [{ id: "add_secret:NPM_TASKFORCESH_TOKEN:npm.taskforce.sh", action: "add_secret", who: "settings", host: "npm.taskforce.sh", secretName: "NPM_TASKFORCESH_TOKEN", label: "Create the secret NPM_TASKFORCESH_TOKEN for npm.taskforce.sh" }],
        };
        render(<BlockerCard environmentId="env-1" group={group} canApply />);
        expect(screen.getByRole("link", { name: "Create the secret NPM_TASKFORCESH_TOKEN" })).toHaveAttribute(
            "href",
            "/runtime/settings?secretName=NPM_TASKFORCESH_TOKEN&secretHost=npm.taskforce.sh#secrets",
        );
        expect(screen.queryByRole("button", { name: /Allow/ })).not.toBeInTheDocument();
    });
});
