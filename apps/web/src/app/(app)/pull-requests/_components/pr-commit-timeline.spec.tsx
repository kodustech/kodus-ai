/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import { usePermission } from "@services/permissions/hooks";
import { usePullRequestFiles } from "@services/pull-requests";
import type {
    PrRuntime,
    PrRunView,
} from "@services/runtime/model/pull-request-runs";
import { useRequestPullRequestRun } from "@services/runtime/pull-request-runs";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { PrCommitTimeline } from "./pr-commit-timeline";

jest.mock("@services/pull-requests", () => ({
    usePullRequestFiles: jest.fn(),
}));
jest.mock("@services/permissions/hooks", () => {
    const usePermission = jest.fn();
    return {
        usePermission,
        usePermissionOnEvery: (...args: unknown[]) => usePermission(...args),
    };
});
jest.mock("@services/runtime/pull-request-runs", () => ({
    useRequestPullRequestRun: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ children, href }: { children: ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

const HEAD = "1".repeat(40);
const REVIEWED = "3c9e1aa".padEnd(40, "0");
const QUIET_1 = "4".repeat(40);
const QUIET_2 = "5".repeat(40);
const FIRST = "6".repeat(40);

const execution = (sha: string, status: string, at: string, sent = 0) => ({
    prId: "pr-1",
    prNumber: 7,
    repositoryId: "repo-1",
    repositoryName: "acme/shop",
    executionId: `exec-${sha.slice(0, 4)}`,
    reviewedCommitSha: sha,
    automationExecution: {
        uuid: `ae-${sha.slice(0, 4)}`,
        status,
        createdAt: at,
    },
    createdAt: at,
    suggestionsCount: { sent, filtered: 0 },
    codeReviewTimeline: [],
});

const run = (patch: Partial<PrRunView>): PrRunView => ({
    runId: "run-1",
    attempt: 1,
    headSha: REVIEWED,
    environmentId: "env-1",
    state: "regression",
    requestedAt: "2026-11-10T10:05:00.000Z",
    regressions: 1,
    probes: 3,
    firstRegression: {
        title: "Orders page",
        field: { path: "items[0].quantity", base: "2", pr: '""' },
        differingFields: ["items[0].quantity"],
        boot: false,
        destabilizes: false,
    },
    ...patch,
});

const runtime = (patch: Partial<PrRuntime> = {}): PrRuntime => ({
    repositoryId: "repo-1",
    prNumber: 7,
    environment: {
        environmentId: "env-1",
        name: "acme/shop",
        ready: true,
        on: true,
    },
    latest: null,
    commits: [run({})],
    ...patch,
});

const reviewOnReviewed = execution(
    REVIEWED,
    "success",
    "2026-11-10T10:00:00.000Z",
    2,
);
const reviewOnFirst = execution(FIRST, "error", "2026-11-08T10:00:00.000Z");
const group = {
    prId: "pr-1",
    latest: reviewOnReviewed,
    executions: [reviewOnReviewed, reviewOnFirst],
    reviewCount: 2,
};

const GRID = "grid grid-cols-6";

beforeEach(() => {
    (usePermission as jest.Mock).mockReturnValue(true);
    (useRequestPullRequestRun as jest.Mock).mockReturnValue({
        mutate: jest.fn(),
        isPending: false,
    });
    (usePullRequestFiles as jest.Mock).mockReturnValue({
        isLoading: false,
        isError: false,
        data: {
            data: {
                files: [],
                // The provider lists them oldest first.
                commits: [
                    {
                        sha: FIRST,
                        message: "first commit",
                        htmlUrl: "https://git/1",
                    },
                    {
                        sha: QUIET_2,
                        message: "quiet two",
                        htmlUrl: "https://git/2",
                    },
                    {
                        sha: QUIET_1,
                        message: "quiet one",
                        htmlUrl: "https://git/3",
                    },
                    {
                        sha: REVIEWED,
                        message: "Show the quantity\n\nbody",
                        htmlUrl: "https://git/4",
                    },
                    {
                        sha: HEAD,
                        message: "Rename a field",
                        htmlUrl: "https://git/5",
                    },
                ],
            },
        },
    });
});

const view = (props: Partial<Parameters<typeof PrCommitTimeline>[0]> = {}) =>
    render(
        <PrCommitTimeline
            group={group as any}
            teamId="team-1"
            grid={GRID}
            runtime={runtime()}
            hasRuntimeColumn
            showRuntime
            renderReviewDetail={(e) => <div>detail of {e.executionId}</div>}
            {...props}
        />,
    );

describe("the timeline by commit", () => {
    it("matches the review and the Run of the same SHA on one commit row", () => {
        view();
        const items = screen.getAllByRole("listitem");
        const row = items.find((i) =>
            within(i).queryByText("Show the quantity"),
        )!;
        expect(within(row).getByText("3c9e1aa")).toBeInTheDocument();
        expect(
            within(row).getByRole("button", { name: /Review 2/ }),
        ).toBeInTheDocument();
        expect(
            within(row).getByRole("link", { name: /1 regression/ }),
        ).toHaveAttribute("href", "/runtime/runs/run-1");
    });

    it("says the regression in plain words under its commit, with the way into the Run", () => {
        view();
        // What Kody checked (the probe's purpose) leads the sentence.
        const line = screen.getByText(/Orders page/);
        expect(line).not.toHaveTextContent(/GET|POST|\/orders/);
        expect(
            within(line).getByRole("link", { name: /Open the Run/ }),
        ).toHaveAttribute("href", "/runtime/runs/run-1");
    });

    it("puts the head first as latest, not run, with a Run button", () => {
        view();
        const [head] = screen.getAllByRole("listitem");
        expect(within(head).getByText("Rename a field")).toBeInTheDocument();
        expect(within(head).getByText("latest")).toBeInTheDocument();
        expect(within(head).getByText("Not run")).toBeInTheDocument();
        expect(
            within(head).getByRole("button", { name: "Run" }),
        ).toBeInTheDocument();
    });

    it("leaves the Run button to the PR row while nothing ran on the PR", () => {
        view({ runtime: runtime({ commits: [] }) });
        const [head] = screen.getAllByRole("listitem");
        expect(within(head).getByText("Not run")).toBeInTheDocument();
        expect(within(head).queryByRole("button", { name: "Run" })).toBeNull();
    });

    it("folds the quiet commits between and opens them on demand", () => {
        view();
        expect(screen.queryByText("quiet one")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "2 more commits" }));
        expect(screen.getByText("quiet one")).toBeInTheDocument();
        expect(screen.getByText("quiet two")).toBeInTheDocument();
    });

    it("opens a review's stages from its commit", () => {
        view();
        fireEvent.click(screen.getByRole("button", { name: /Review 1/ }));
        expect(
            screen.getByText(`detail of ${reviewOnFirst.executionId}`),
        ).toBeInTheDocument();
    });

    it("names each review by what it came to, a skip after a failed step as failed", () => {
        const stoppedAtCommits = {
            ...execution(HEAD, "skipped", "2026-11-11T10:00:00.000Z"),
            codeReviewTimeline: [
                { uuid: "t1", status: "success", message: "Started" },
                { uuid: "t2", status: "error", message: "Not Found" },
                { uuid: "t3", status: "skipped", message: "Unable to load" },
            ],
        };
        view({
            group: {
                ...group,
                latest: stoppedAtCommits,
                executions: [stoppedAtCommits, reviewOnReviewed, reviewOnFirst],
                reviewCount: 3,
            } as any,
        });
        expect(
            screen.getByRole("button", { name: /Review 3\s*failed/ }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /Review 2\s*passed/ }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /Review 1\s*failed/ }),
        ).toBeInTheDocument();
    });

    it("says under the commit where a failed review stopped and why, and opens its steps from the commit's chevron", () => {
        const stopped = {
            ...execution(HEAD, "skipped", "2026-11-11T10:00:00.000Z"),
            codeReviewTimeline: [
                {
                    uuid: "t1",
                    status: "success",
                    message: "Started",
                    stageName: "KodyReviewStartedStage",
                },
                {
                    uuid: "t2",
                    status: "error",
                    stageName: "CheckingCommitsStage",
                    message:
                        "Not Found - https://docs.github.com/rest/reference/apps#create-an-installation-access-token-for-an-app",
                },
            ],
        };
        view({
            group: {
                ...group,
                latest: stopped,
                executions: [stopped, reviewOnReviewed, reviewOnFirst],
                reviewCount: 3,
            } as any,
        });
        const head = screen
            .getByText("Rename a field")
            .closest("[role=listitem]") as HTMLElement;
        expect(head).toHaveTextContent("Kody stopped at Checking Commits");
        expect(head).toHaveTextContent(
            "GitHub can't find the Kodus app on this repository",
        );
        expect(
            within(head).queryByRole("link", { name: "Git settings" }),
        ).not.toBeInTheDocument();
        fireEvent.click(
            within(head).getByRole("button", {
                name: "Show the review's steps",
            }),
        );
        expect(
            screen.getByText(`detail of ${stopped.executionId}`),
        ).toBeInTheDocument();
    });

    it("shows a review that recorded no commit on the commit that was latest when it ran, never as an unknown commit", () => {
        const noSha = {
            ...execution(HEAD, "skipped", "2026-11-11T10:00:00.000Z"),
            reviewedCommitSha: undefined,
            executionId: "exec-nosha",
        };
        view({
            group: {
                ...group,
                latest: noSha,
                executions: [noSha, reviewOnReviewed, reviewOnFirst],
                reviewCount: 3,
            } as any,
        });
        expect(screen.queryByText(/Unknown commit/)).not.toBeInTheDocument();
        expect(
            screen.queryByText(/Commit not recorded/),
        ).not.toBeInTheDocument();
        const head = screen
            .getByText("Rename a field")
            .closest("[role=listitem]") as HTMLElement;
        expect(
            within(head).getByRole("button", { name: /Review 3/ }),
        ).toBeInTheDocument();
    });

    it("shows no Runtime result to a viewer who may not read this repository's Runs", () => {
        view({ showRuntime: false });
        expect(screen.queryByRole("link", { name: /regression/ })).toBeNull();
        expect(screen.queryByText(/Orders page/)).toBeNull();
        expect(screen.queryByText("Not run")).toBeNull();
    });

    it("without the branch's commits, lists the commits Kody reviewed or ran on", () => {
        (usePullRequestFiles as jest.Mock).mockReturnValue({
            isLoading: false,
            isError: true,
            data: undefined,
        });
        view();
        expect(screen.getByText("3c9e1aa")).toBeInTheDocument();
        expect(screen.getByText("6666666")).toBeInTheDocument();
        expect(
            screen.getByText(/Couldn.t load the branch/),
        ).toBeInTheDocument();
    });

    it("for an org without the Runtime column, opening the row asks the Git provider for nothing and lists the reviewed commits", () => {
        (usePullRequestFiles as jest.Mock).mockClear();
        view({ hasRuntimeColumn: false, showRuntime: false });
        // No team: the files query (the PR's whole diff) stays disabled.
        expect(usePullRequestFiles).toHaveBeenLastCalledWith(
            expect.any(String),
            expect.any(Number),
            undefined,
            "shop",
        );
        expect(screen.getByText("3c9e1aa")).toBeInTheDocument();
        expect(screen.queryByText(/Loading the commits/)).toBeNull();
        expect(screen.queryByText(/Couldn.t load the branch/)).toBeNull();
    });
});
