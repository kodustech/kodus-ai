/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { RuntimeEnvironment } from "@services/runtime/contracts";
import { render, screen, within } from "@testing-library/react";

import {
    EnvironmentSetupCard,
    SetupEnvironmentButton,
} from "./environment-setup";

jest.mock("@services/permissions/hooks", () => ({
    usePermission: () => true,
    usePermissionOnEvery: () => true,
}));
jest.mock("@services/runtime/queries", () => ({
    useRequestEnvironmentSetup: () => ({ mutate: jest.fn(), isPending: false }),
}));

const at = "2026-11-11T12:00:00Z";
const env = (
    setup: Partial<NonNullable<RuntimeEnvironment["setup"]>>,
): RuntimeEnvironment =>
    ({
        environmentId: "env-1",
        repositoryId: "repo-1",
        state: setup.state ?? "active",
        setup: {
            state: "active",
            steps: [],
            blockers: [],
            requestedAt: at,
            updatedAt: at,
            finishedAt: at,
            ...setup,
        },
    }) as unknown as RuntimeEnvironment;

describe("EnvironmentSetupCard, repairs of Kody's setup file", () => {
    it("says Kody rewrote the recipe after the build failed, with the attempt and what failed, and labels the repair's steps", () => {
        render(
            <EnvironmentSetupCard
                detailed
                env={env({
                    steps: [
                        { name: "recipe", state: "done", startedAt: at },
                        { name: "boot", state: "failed", startedAt: at },
                        {
                            name: "recipe",
                            state: "done",
                            startedAt: at,
                            repair: 1,
                        },
                        {
                            name: "boot",
                            state: "done",
                            startedAt: at,
                            repair: 1,
                        },
                    ],
                    progress: {
                        phases: [],
                        lines: ["#9 RUN go build ./..."],
                        updatedAt: at,
                    },
                    repairs: [
                        {
                            n: 1,
                            max: 2,
                            blocker: {
                                kind: "toolchain",
                                signature: "compose_up",
                                title: "The project failed to build or start",
                            },
                            failedDigest: "sha256:a",
                            recipeDigest: "sha256:b",
                            outcome: "booted",
                            at,
                        },
                    ],
                })}
            />,
        );
        const repairs = screen.getByRole("list", {
            name: "Kody's setup file repairs",
        });
        expect(repairs).toHaveTextContent("attempt 1 of 2");
        expect(repairs).toHaveTextContent(
            "The project failed to build or start",
        );
        const steps = within(
            screen.getByRole("list", { name: "Setup steps" }),
        ).getAllByRole("listitem");
        expect(steps.map((s) => s.textContent)).toEqual([
            expect.stringContaining("Read the setup file"),
            expect.not.stringContaining("(repair"),
            expect.stringContaining("(repair 1)"),
            expect.stringContaining("(repair 1)"),
        ]);
        // The cell's last output belongs to the repair's boot, not to the one it replaced.
        expect(steps[1]).not.toHaveTextContent("RUN go build");
        expect(steps[3]).toHaveTextContent("RUN go build");
    });

    it("shows no repair line for a setup that made none", () => {
        render(
            <EnvironmentSetupCard
                detailed
                env={env({
                    steps: [{ name: "boot", state: "done", startedAt: at }],
                })}
            />,
        );
        expect(
            screen.queryByRole("list", { name: "Kody's setup file repairs" }),
        ).not.toBeInTheDocument();
    });
});

describe("SetupEnvironmentButton in a list row", () => {
    it("is an icon named after its environment, its label in the tooltip", () => {
        render(
            <SetupEnvironmentButton env={env({})} iconOnly name="acme/shop" />,
        );
        const button = screen.getByRole("button", {
            name: "Set up again acme/shop",
        });
        expect(button.textContent?.trim()).toBe("");
        expect(button).toHaveAttribute("title", "Set up again acme/shop");
    });
});
