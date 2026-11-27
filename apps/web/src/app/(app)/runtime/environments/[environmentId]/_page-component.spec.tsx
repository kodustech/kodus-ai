/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import type {
    EnvironmentSetup,
    RuntimeEnvironment,
} from "@services/runtime/contracts";
import { fireEvent, render, screen } from "@testing-library/react";

import { EnvironmentDetailPage } from "./_page-component";

const mockEnvironment = { data: undefined as RuntimeEnvironment | undefined };
const mockBlockers = { data: [] as unknown[] };
const mockLessons = { data: [] as unknown[] };
const mockEnvironments = { data: [] as RuntimeEnvironment[] };

jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ children, href }: { children: ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
jest.mock("@services/permissions/hooks", () => ({
    usePermission: () => true,
    usePermissionOnEvery: () => true,
}));
jest.mock("@services/runtime/queries", () => ({
    useRuntimeEnvironment: () => ({
        isLoading: false,
        isError: false,
        data: mockEnvironment.data,
    }),
    useEnvironmentBlockers: () => ({
        isLoading: false,
        isError: false,
        data: mockBlockers.data,
    }),
    useEnvironmentLessons: () => ({ data: mockLessons.data }),
    useProposeInferredRecipe: () => ({ mutate: jest.fn(), isPending: false }),
    useRuntimeEnvironments: () => ({ data: mockEnvironments.data }),
    useRuntimeSettings: () => ({ data: { repositories: [] } }),
}));
jest.mock("./_components/e2e-suite", () => ({
    EnvironmentSuiteSection: ({ environmentId }: { environmentId: string }) => (
        <section aria-label="e2e suite">{environmentId}</section>
    ),
}));
jest.mock("./_components/repositories", () => ({
    EnvironmentRepositories: ({
        env,
    }: {
        env: { repositories: unknown[] };
    }) => (
        <section aria-label="Repositories">
            {env.repositories.length} repositories
        </section>
    ),
}));
jest.mock("@components/runtime/environment-setup", () => ({
    SetupEnvironmentButton: () => <button type="button">Set up</button>,
    EnvironmentSetupCard: () => <p>steps</p>,
}));
jest.mock("@components/runtime/kody-attempts", () => ({
    KodyAttempts: () => null,
}));
jest.mock("@components/runtime/blocker-card", () => ({
    BlockerCard: ({ group }: { group: { signature: string } }) => (
        <p>{group.signature}</p>
    ),
}));
jest.mock("@components/runtime/simulate-on-past-prs", () => ({
    SimulateOnPastPrs: () => <p>simulate form</p>,
}));
jest.mock("./_components/lessons", () => ({
    EnvironmentLessons: () => <p>lessons list</p>,
}));
jest.mock("./_components/machine-size", () => ({
    MachineSizeSetting: () => <p>machine size form</p>,
}));
jest.mock("./_components/fork-pull-requests", () => ({
    ForkPullRequestsSetting: () => <p>forks form</p>,
}));
jest.mock("./_components/warm-pool", () => ({
    WarmPool: () => <p>warm pool form</p>,
}));
jest.mock("./_components/egress-approval", () => ({
    ApproveHostForm: () => <p>approve host form</p>,
}));
jest.mock("@components/runtime/egress-access", () => ({
    EgressApprovalsList: () => <p>approved hosts</p>,
}));
// The preview section reaches next-auth (ESM-only) through the auth provider.
jest.mock("./_components/environment-preview", () => ({
    EnvironmentPreviewSection: () => <p>preview section</p>,
}));

const at = "2026-11-10T12:00:00.000Z";
const setup = (patch: Partial<EnvironmentSetup> = {}): EnvironmentSetup => ({
    state: "active",
    steps: [],
    blockers: [],
    requestedAt: at,
    updatedAt: at,
    finishedAt: at,
    sha: "b".repeat(40),
    recipe: {
        path: ".kodus/workspace.yaml",
        sha: "c".repeat(40),
        state: "found",
    },
    ...patch,
});
const env = (patch: Partial<RuntimeEnvironment> = {}): RuntimeEnvironment => ({
    environmentId: "env-1",
    repositoryId: "r1",
    repositoryName: "acme/shop",
    state: "active",
    machineSize: null,
    forkPullRequests: "require_approval",
    pool: { size: 1, setting: null, defaultSize: 1, maxSize: 3 },
    ...patch,
});
const section = (name: string) => screen.queryByRole("region", { name });
/** A folded section of the page: its <details>, found by its title. */
const fold = (name: string) =>
    screen.queryByRole("heading", { name })?.closest("details") ?? null;

beforeAll(() => {
    if (!("ResizeObserver" in globalThis)) {
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
});
beforeEach(() => {
    mockBlockers.data = [];
    mockLessons.data = [];
    mockEnvironments.data = [];
    window.location.hash = "";
});

describe("Environment page", () => {
    it("a new environment shows the next step and the setup, and nothing it cannot fill yet", () => {
        mockEnvironment.data = env();
        render(<EnvironmentDetailPage environmentId="env-1" />);
        expect(section("Next step")).toBeInTheDocument();
        expect(fold("Last setup")).toHaveAttribute("id", "setup");
        // No metric cards of "—", no simulation without a setup, no empty
        // blockers or lessons panels.
        expect(screen.queryByText("Boot success (7d)")).not.toBeInTheDocument();
        expect(section("Simulate on past PRs")).not.toBeInTheDocument();
        expect(section("Blockers")).not.toBeInTheDocument();
        expect(section("What Kody learned")).not.toBeInTheDocument();
        // The settings wait behind one line that says what they are.
        const settings = fold("Settings")!;
        expect(settings.open).toBe(false);
        expect(settings.querySelector("summary")).toHaveTextContent(
            "Default machine size · forks wait for a maintainer · 1 machine kept ready · no extra outbound hosts",
        );
    });

    it("opens the settings on a click, and offers no warm pool before a ready setup", () => {
        mockEnvironment.data = env();
        render(<EnvironmentDetailPage environmentId="env-1" />);
        const settings = fold("Settings")!;
        fireEvent.click(settings.querySelector("summary")!);
        expect(settings.open).toBe(true);
        expect(screen.getByText("machine size form")).toBeInTheDocument();
        expect(screen.queryByText("warm pool form")).not.toBeInTheDocument();
    });

    it("a blocker's link to the machine size opens the settings", () => {
        window.location.hash = "#machine-size";
        mockEnvironment.data = env({ setup: setup() });
        render(<EnvironmentDetailPage environmentId="env-1" />);
        expect(fold("Settings")!.open).toBe(true);
    });

    it("a ready environment folds its last setup, the takeaway on the summary", () => {
        mockEnvironment.data = env({ setup: setup() });
        render(<EnvironmentDetailPage environmentId="env-1" />);
        const last = fold("Last setup")!;
        expect(last.open).toBe(false);
        expect(last.querySelector("summary")).toHaveTextContent(
            /Finished ready/,
        );
    });

    it("a setup in progress opens its steps", () => {
        mockEnvironment.data = env({
            state: "setting_up",
            setup: setup({ state: "setting_up" as EnvironmentSetup["state"] }),
        });
        render(<EnvironmentDetailPage environmentId="env-1" />);
        expect(fold("Last setup")!.open).toBe(true);
    });

    it("ready: the simulation, the repository's recipe and what was learned show", () => {
        mockEnvironment.data = env({ setup: setup() });
        mockLessons.data = [{ lessonId: "l1" }];
        render(<EnvironmentDetailPage environmentId="env-1" />);
        expect(section("Simulate on past PRs")).toHaveAttribute(
            "id",
            "simulation",
        );
        expect(section("Setup file")).toHaveAttribute("id", "recipe");
        expect(section("What Kody learned")).toBeInTheDocument();
    });

    it("a managed environment has its e2e suite section, which is hidden by itself when the recipe declares none", () => {
        mockEnvironment.data = env({ setup: setup() });
        render(<EnvironmentDetailPage environmentId="env-1" />);
        expect(screen.getByRole("region", { name: "e2e suite" })).toHaveTextContent("env-1");
    });

    it("blocked: the blockers section stays, since the next step points at it", () => {
        mockEnvironment.data = env({
            state: "blocked",
            setup: setup({
                state: "blocked",
                blockers: [
                    { kind: "boot_timeout", signature: "s", message: "m", at },
                ],
            }),
        });
        render(<EnvironmentDetailPage environmentId="env-1" />);
        expect(section("Blockers")).toHaveAttribute("id", "blockers");
        expect(
            screen.getByRole("link", { name: /Open the blocker/ }),
        ).toHaveAttribute("href", "#blockers");
        // What to fix comes right after the answer, before the record of the setup.
        expect(
            section("Next step")!.compareDocumentPosition(
                section("Blockers")!,
            ) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
            section("Blockers")!.compareDocumentPosition(fold("Last setup")!) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });

    // Behavior: a blocker the API reports as fixed is not shown as a problem with a fix button; it is listed under Resolved.
    it("ready: a blocker a later setup cleared is listed as resolved, not as an open blocker", () => {
        mockEnvironment.data = env({ state: "active" });
        mockBlockers.data = [
            {
                signature: "boot_timeout",
                kind: "resources",
                title: "The app did not become ready in time",
                count: 1,
                lastAt: at,
                state: "fixed",
                resolvedAt: at,
                fixes: [
                    {
                        id: "bump",
                        action: "bump_machine",
                        who: "dev",
                        label: "Fix the recipe",
                    },
                ],
            },
        ];
        render(<EnvironmentDetailPage environmentId="env-1" />);
        const blockers = section("Blockers")!;
        expect(blockers).toHaveTextContent("No open blocker");
        expect(blockers).toHaveTextContent("Resolved (1)");
        expect(blockers).not.toHaveTextContent("Seen fewer than 10 times");
    });

    it("lists every repository of a system in its own section", () => {
        const repo = (
            id: string,
            name: string,
            role: "primary" | "member",
        ) => ({
            repositoryId: id,
            repositoryName: name,
            fullName: name,
            alias: name.split("/")[1],
            role,
            triggers: true,
            pairBranches: false,
        });
        mockEnvironment.data = env({
            repositories: [
                repo("r1", "acme/shop", "primary"),
                repo("r2", "acme/billing", "member"),
                repo("r3", "acme/auth", "member"),
            ],
        });
        render(<EnvironmentDetailPage environmentId="env-1" />);
        expect(section("Repositories")).toHaveTextContent("3 repositories");
    });

    it("an environment known only from earlier Runs offers no setup, no settings and no simulation, and links to its repository's managed environment", () => {
        const runOnly = env({
            environmentId: "h1-pkg-shop-repo",
            managed: false,
            setup: setup(),
            machineSize: undefined,
            forkPullRequests: undefined,
            pool: undefined,
        });
        mockEnvironment.data = runOnly;
        mockEnvironments.data = [runOnly, env({ managed: true })];
        render(<EnvironmentDetailPage environmentId="h1-pkg-shop-repo" />);
        expect(
            screen.queryByRole("button", { name: "Set up" }),
        ).not.toBeInTheDocument();
        expect(fold("Settings")).toBeNull();
        expect(section("Simulate on past PRs")).not.toBeInTheDocument();
        expect(screen.queryByRole("region", { name: "e2e suite" })).not.toBeInTheDocument();
        expect(
            screen
                .getAllByRole("link")
                .map((a) => a.getAttribute("href")),
        ).toContain("/runtime/environments/env-1");
    });

    it("an environment the API lists no repositories for has no Repositories section", () => {
        mockEnvironment.data = env();
        render(<EnvironmentDetailPage environmentId="env-1" />);
        expect(section("Repositories")).not.toBeInTheDocument();
    });
});
