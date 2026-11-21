/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import type {
    EnvironmentSetup,
    RuntimeEnvironment,
} from "@services/runtime/contracts";
import { fireEvent, render, screen } from "@testing-library/react";

import { EnvironmentNextStep } from "./next-step";

jest.mock("next/link", () => ({
    __esModule: true,
    default: ({
        children,
        href,
        onClick,
    }: {
        children: ReactNode;
        href: string;
        onClick?: () => void;
    }) => (
        <a href={href} onClick={onClick}>
            {children}
        </a>
    ),
}));
jest.mock("@components/runtime/environment-setup", () => ({
    SetupEnvironmentButton: ({ variant }: { variant?: string }) => (
        <button type="button" data-variant={variant}>
            Set up
        </button>
    ),
}));

const at = "2026-11-10T12:00:00.000Z";
const setup = (patch: Partial<EnvironmentSetup> = {}): EnvironmentSetup => ({
    state: "active",
    steps: [],
    blockers: [],
    requestedAt: at,
    updatedAt: at,
    finishedAt: "2026-11-10T12:03:00.000Z",
    sha: "b".repeat(40),
    branch: "main",
    ...patch,
});
const env = (patch: Partial<RuntimeEnvironment> = {}): RuntimeEnvironment => ({
    environmentId: "env-1",
    repositoryId: "r1",
    repositoryName: "acme/shop",
    state: "active",
    ...patch,
});

describe("EnvironmentNextStep", () => {
    it("a new environment: offers to set it up", () => {
        render(<EnvironmentNextStep env={env()} canSetUp />);
        expect(
            screen.getByRole("button", { name: "Set up" }),
        ).toBeInTheDocument();
        // No setup yet: no commit, only where the machines run.
        expect(screen.queryByText(/Runs boot from/)).not.toBeInTheDocument();
        expect(screen.getByText("Machines on Kodus cloud")).toBeInTheDocument();
    });

    it("offers no Set up to someone who cannot set it up", () => {
        render(<EnvironmentNextStep env={env()} canSetUp={false} />);
        expect(
            screen.queryByRole("button", { name: "Set up" }),
        ).not.toBeInTheDocument();
    });

    it("a failed setup leads to the blocker", () => {
        render(
            <EnvironmentNextStep
                env={env({
                    state: "blocked",
                    setup: setup({
                        state: "blocked",
                        blockers: [
                            {
                                kind: "boot_timeout",
                                signature: "s",
                                message: "web never answered on :3000",
                                at,
                            },
                        ],
                    }),
                })}
                canSetUp
            />,
        );
        expect(
            screen.getByText("web never answered on :3000"),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: /Open the blocker/ }),
        ).toHaveAttribute("href", "#blockers");
    });

    it("ready: names what Runs boot from and offers a simulation", () => {
        render(
            <EnvironmentNextStep
                env={env({
                    setup: setup({
                        recipe: {
                            path: ".kodus/workspace.yaml",
                            sha: "c".repeat(40),
                            state: "found",
                        },
                    }),
                })}
                canSetUp
            />,
        );
        expect(screen.getByText(/Runs boot from main at/)).toHaveTextContent(
            "bbbbbbb",
        );
        expect(
            screen.getByRole("link", { name: /Simulate on past PRs/ }),
        ).toHaveAttribute("href", "#simulation");
    });

    it("a step that points at a closed section opens it", () => {
        render(
            <>
                <EnvironmentNextStep
                    env={env({ state: "setting_up", setup: setup() })}
                    canSetUp
                />
                <details id="setup">
                    <summary>Last setup</summary>
                </details>
            </>,
        );
        const details = document.getElementById("setup") as HTMLDetailsElement;
        expect(details.open).toBe(false);
        fireEvent.click(screen.getByRole("link", { name: /Watch the steps/ }));
        expect(details.open).toBe(true);
    });
});
