/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { onboardingState } from "@services/runtime/model/onboarding";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { FirstRun } from "./first-run";

const mutate = jest.fn();
jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ href, children, ...rest }: any) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));
jest.mock("@services/runtime/queries", () => ({
    useCreateRuntimeEnvironment: () => ({
        mutate,
        isPending: false,
        isSuccess: false,
    }),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

const repositories = [
    { repositoryId: "r2", repositoryName: "acme/search", whoCanAsk: "anyone" as any, mode: "on_request" as const },
    { repositoryId: "r1", repositoryName: "acme/billing", whoCanAsk: "anyone" as any, mode: "off" as const },
];
const env = (state: any, setup?: any) => ({
    environmentId: "env-1",
    repositoryId: "r1",
    repositoryName: "acme/billing",
    state,
    setup,
});

const stepState = (n: number) =>
    screen.getByRole("listitem", { name: new RegExp(`^Step ${n}:`) }).dataset.state;

const renderFor = (environments: any[], readyHasRuns?: boolean, canCreate = true) =>
    render(
        <FirstRun
            onboarding={onboardingState(environments, readyHasRuns)!}
            environments={environments}
            repositories={repositories}
            canCreate={canCreate}
        />,
    );

describe("FirstRun", () => {
    beforeEach(() => mutate.mockReset());

    it("step 1 lists the connected repositories, each with its own Set up, and the agent prompt under it", () => {
        renderFor([]);
        expect([stepState(1), stepState(2), stepState(3)]).toEqual(["current", "upcoming", "upcoming"]);
        const list = screen.getByRole("list", { name: "Connected repositories" });
        expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
            expect.stringContaining("billing"),
            expect.stringContaining("search"),
        ]);
        fireEvent.click(screen.getByRole("button", { name: "Set up acme/search" }));
        expect(mutate).toHaveBeenCalledWith("r2", expect.any(Object));
    });

    it("offers no Set up to someone who cannot create environments", () => {
        renderFor([], undefined, false);
        expect(screen.queryByRole("button", { name: /^Set up/ })).not.toBeInTheDocument();
    });

    it("step 2 follows the first setup, and says so when it is blocked", () => {
        const { unmount } = renderFor([env("setting_up", { state: "setting_up" })]);
        expect([stepState(1), stepState(2), stepState(3)]).toEqual(["done", "current", "upcoming"]);
        expect(screen.getByRole("link", { name: "Follow the setup" })).toHaveAttribute(
            "href",
            "/runtime/environments/env-1",
        );
        expect(screen.queryByRole("list", { name: "Connected repositories" })).not.toBeInTheDocument();
        // Another repository can still be picked meanwhile.
        fireEvent.click(screen.getByRole("button", { name: "Set up another repository" }));
        expect(screen.getByRole("button", { name: "Set up acme/search" })).toBeInTheDocument();
        unmount();

        renderFor([env("blocked", { state: "blocked", blockers: [{ kind: "no_recipe" }] })]);
        expect(screen.getByRole("link", { name: "Open the setup" })).toHaveAttribute(
            "href",
            "/runtime/environments/env-1",
        );
    });

    it("step 3 gives the command to test a pull request, and the way to turn Runtime on when it is Off", () => {
        renderFor([env("active", { state: "active" })], false);
        expect([stepState(1), stepState(2), stepState(3)]).toEqual(["done", "done", "current"]);
        expect(screen.getByText("@kody runtime")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Open Runtime settings" })).toHaveAttribute(
            "href",
            "/runtime/settings",
        );
    });
});
