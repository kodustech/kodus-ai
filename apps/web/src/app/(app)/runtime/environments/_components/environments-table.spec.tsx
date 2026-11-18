/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen, within } from "@testing-library/react";

import { EnvironmentsTable } from "./environments-table";
import { agentPrompt } from "./new-environment";

const mutate = jest.fn();
jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ href, children, ...rest }: any) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));
jest.mock("@components/runtime/environment-setup", () => ({
    SetupEnvironmentButton: ({ env }: any) => (
        <button type="button">Set up again {env.repositoryName}</button>
    ),
}));
jest.mock("@services/runtime/queries", () => ({
    useCreateRuntimeEnvironment: () => ({
        mutate,
        isPending: false,
        isSuccess: false,
    }),
}));

const ready = {
    environmentId: "env-2",
    repositoryId: "r2",
    repositoryName: "acme/checkout",
    state: "active" as const,
    setup: { state: "active" } as any,
};
const noRecipe = {
    environmentId: "env-4",
    repositoryId: "r4",
    repositoryName: "acme/docs",
    state: "blocked" as const,
    setup: { state: "blocked", blockers: [{ kind: "no_recipe" }] } as any,
};
const repositories = [
    { repositoryId: "r3", repositoryName: "acme/search" },
    { repositoryId: "r1", repositoryName: "acme/billing-service" },
    { repositoryId: "r2", repositoryName: "acme/checkout" },
    { repositoryId: "r4", repositoryName: "acme/docs" },
];

const bodyRows = () =>
    within(screen.getAllByRole("rowgroup")[1])
        .getAllByRole("row")
        .map((r) => r.textContent ?? "");

describe("Environments table (one list)", () => {
    beforeEach(() => mutate.mockReset());

    it("lists every connected repository once: what needs attention first, then ready, then the ones not set up with their own Set up", () => {
        render(
            <EnvironmentsTable
                environments={[ready, noRecipe]}
                repositories={repositories}
                canCreate
            />,
        );
        const rows = bodyRows();
        expect(rows).toHaveLength(4);
        expect(rows[0]).toContain("docs");
        expect(rows[1]).toContain("checkout");
        expect(rows[2]).toContain("billing-service");
        expect(rows[2]).toContain("Not set up");
        expect(rows[3]).toContain("search");
        fireEvent.click(
            screen.getByRole("button", { name: "Set up acme/search" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Set up acme/billing-service" }),
        );
        expect(mutate).toHaveBeenCalledWith("r3", expect.any(Object));
        expect(mutate).toHaveBeenCalledWith("r1", expect.any(Object));
        expect(
            screen.getByRole("button", { name: "Set up again acme/checkout" }),
        ).toBeInTheDocument();
    });

    it("a row offers Set up as an icon named after its repository, not an amber button repeated down the column", () => {
        render(
            <EnvironmentsTable
                environments={[ready, noRecipe]}
                repositories={repositories}
                canCreate
            />,
        );
        const setUp = screen.getByRole("button", {
            name: "Set up acme/search",
        });
        expect(setUp.textContent?.trim()).toBe("");
        expect(setUp).toHaveAttribute("title", "Set up acme/search");
    });

    it("filters by name, by not set up and by needs attention", () => {
        render(
            <EnvironmentsTable
                environments={[ready, noRecipe]}
                repositories={repositories}
                canCreate
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Not set up · 2" }));
        expect(bodyRows()).toEqual([
            expect.stringContaining("billing-service"),
            expect.stringContaining("search"),
        ]);
        fireEvent.click(
            screen.getByRole("button", { name: "Needs attention · 1" }),
        );
        expect(bodyRows()).toEqual([expect.stringContaining("docs")]);
        fireEvent.click(screen.getByRole("button", { name: "All · 4" }));
        fireEvent.change(
            screen.getByRole("textbox", { name: "Search repositories" }),
            { target: { value: "sear" } },
        );
        expect(bodyRows()).toEqual([expect.stringContaining("search")]);
    });

    it("counts an environment never set up as not set up, says a failed try, and tells same-named repositories apart", () => {
        const never = {
            environmentId: "env-5",
            repositoryId: "r5",
            repositoryName: "acme/shop",
            state: "active" as const,
        };
        const twin = {
            environmentId: "env-6",
            repositoryId: "r6",
            repositoryName: "other/shop",
            state: "active" as const,
            setup: { state: "active" } as any,
        };
        const failed = {
            environmentId: "env-7",
            repositoryId: "r7",
            repositoryName: "acme/api",
            state: "blocked" as const,
            setup: {
                state: "blocked",
                updatedAt: new Date().toISOString(),
                blockers: [{ kind: "compose_up", message: "x" }],
            } as any,
        };
        render(
            <EnvironmentsTable
                environments={[never, twin, failed]}
                repositories={[]}
                canCreate
            />,
        );
        const rows = bodyRows();
        // Failed first, ready, never set up last.
        expect(rows[0]).toContain("api");
        expect(rows[0]).toContain("Last try failed");
        expect(rows[1]).toContain("other/shop");
        expect(rows[2]).toContain("acme/shop");
        expect(rows[2]).toContain("Not set up");
        expect(
            screen.getByRole("button", { name: "Not set up · 1" }),
        ).toBeInTheDocument();
    });

    it("an environment known only from earlier Runs offers no Set up again, is not counted as not set up, and links to its repository's managed environment", () => {
        const runOnly = {
            environmentId: "h1-pkg-checkout-repo",
            repositoryId: "r2",
            repositoryName: "acme/checkout",
            managed: false,
        };
        render(
            <EnvironmentsTable
                environments={[{ ...ready, managed: true }, runOnly]}
                repositories={[]}
                canCreate
            />,
        );
        const rowOf = (environmentId: string) =>
            within(screen.getAllByRole("rowgroup")[1])
                .getAllByRole("row")
                .find((r) =>
                    within(r)
                        .queryAllByRole("link")
                        .some(
                            (a) =>
                                a.getAttribute("href") ===
                                `/runtime/environments/${environmentId}`,
                        ),
                );
        const row = rowOf("h1-pkg-checkout-repo")!;
        expect(within(row).queryByRole("button")).not.toBeInTheDocument();
        expect(
            within(row)
                .getAllByRole("link")
                .map((a) => a.getAttribute("href")),
        ).toContain("/runtime/environments/env-2");
        expect(
            within(rowOf("env-2")!).getByRole("button"),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /^Not set up/ }));
        expect(rowOf("h1-pkg-checkout-repo")).toBeUndefined();
    });

    it("offers no Set up to someone who cannot create environments", () => {
        render(
            <EnvironmentsTable
                environments={[]}
                repositories={repositories}
                canCreate={false}
            />,
        );
        expect(
            screen.queryByRole("button", { name: /^Set up acme/ }),
        ).not.toBeInTheDocument();
    });

    it("the agent prompt names the repository and the recipe, and keeps secrets out", () => {
        const prompt = agentPrompt("acme/billing-service");
        expect(prompt).toContain(
            "Write .kodus/workspace.yaml for acme/billing-service",
        );
        expect(prompt).toContain("Never copy .env or any secret");
    });

    it("lists a system with its repositories as chips, the primary first, and a member elsewhere as part of it", () => {
        const repo = (
            repositoryId: string,
            name: string,
            role: "primary" | "member",
            triggers = true,
        ) => ({
            repositoryId,
            repositoryName: name,
            fullName: name,
            alias: name.split("/")[1],
            role,
            triggers,
            pairBranches: false,
        });
        const platform = {
            ...ready,
            repositories: [
                repo("r1", "acme/billing-service", "member"),
                repo("r2", "acme/checkout", "primary"),
                repo("r3", "acme/search", "member", false),
            ],
        };
        render(
            <EnvironmentsTable
                environments={[platform, noRecipe]}
                repositories={repositories}
                canCreate
            />,
        );
        const chips = within(
            screen.getByRole("list", { name: "Repositories of checkout" }),
        )
            .getAllByRole("listitem")
            .map((li) => li.textContent);
        expect(chips).toEqual(["checkout", "billing-service", "search"]);
        // A single-repository environment is one chip.
        expect(
            within(
                screen.getByRole("list", { name: "Repositories of docs" }),
            ).getAllByRole("listitem"),
        ).toHaveLength(1);
        const rows = bodyRows();
        const search = rows.find((r) => r.startsWith("search"))!;
        expect(search).toContain("Part of");
        expect(search).toContain("its own pull requests start no Run");
        expect(rows.find((r) => r.startsWith("billing-service"))).toContain(
            "Its pull requests run in checkout",
        );
        expect(
            within(screen.getAllByRole("rowgroup")[1])
                .getAllByRole("link", { name: "checkout" })
                .map((a) => a.getAttribute("href")),
        ).toEqual([
            "/runtime/environments/env-2",
            "/runtime/environments/env-2#repositories",
            "/runtime/environments/env-2#repositories",
        ]);
        // Members are set up as part of their system: nothing is left to set up.
        expect(
            screen.getByRole("button", { name: "Not set up · 0" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Set up acme/search" }),
        ).not.toBeInTheDocument();
        // The search finds a system by any of its repositories.
        fireEvent.change(
            screen.getByRole("textbox", { name: "Search repositories" }),
            { target: { value: "billing" } },
        );
        expect(bodyRows().map((r) => r.slice(0, 15))).toEqual([
            "checkoutcheckou",
            "billing-service",
        ]);
    });
});
