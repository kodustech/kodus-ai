import type {
    EnvironmentRepository,
    RuntimeEnvironment,
    RunWorkspaceRef,
} from "../contracts";
import {
    addableRepositories,
    aliasProblem,
    defaultRepositoryAlias,
    environmentRepositoriesOf,
    isEnvironmentFull,
    membershipsByRepository,
    namesInWords,
    otherEnvironmentsOf,
    ownModeNote,
    pullRequestBranchOf,
    ranWithOf,
    repositoryChangeError,
    repositoryIdsOfEnvironment,
    repositoryIdsOfRun,
    withRepositoriesAnswer,
    workspaceSideRows,
} from "./environment-repositories";

const repo = (
    repositoryId: string,
    fullName: string,
    role: EnvironmentRepository["role"] = "member",
    patch: Partial<EnvironmentRepository> = {},
): EnvironmentRepository => ({
    repositoryId,
    repositoryName: fullName,
    fullName,
    alias: defaultRepositoryAlias(fullName),
    role,
    triggers: true,
    pairBranches: false,
    ...patch,
});

const env = (
    environmentId: string,
    primary: EnvironmentRepository,
    members: EnvironmentRepository[] = [],
): RuntimeEnvironment => ({
    environmentId,
    repositoryId: primary.repositoryId,
    repositoryName: primary.fullName,
    repositories: [...members, primary],
});

const auth = repo("r-auth", "acme/auth-service");
const platform = env("env-platform", repo("r-app", "acme/app", "primary"), [
    repo("r-billing", "acme/billing", "member", { pairBranches: true }),
    auth,
]);
const checkout = env(
    "env-checkout",
    repo("r-shop", "acme/storefront", "primary"),
    [{ ...auth, triggers: false }],
);

describe("environmentRepositoriesOf", () => {
    it("puts the primary first", () => {
        expect(
            environmentRepositoriesOf(platform).map((r) => r.repositoryId),
        ).toEqual(["r-app", "r-billing", "r-auth"]);
    });

    it("stands in with the primary alone when the API lists none", () => {
        expect(
            environmentRepositoriesOf({
                repositoryId: "r1",
                repositoryName: "acme/Shop_Web",
            }),
        ).toEqual([
            expect.objectContaining({
                repositoryId: "r1",
                role: "primary",
                alias: "shop_web",
                triggers: true,
            }),
        ]);
    });
});

describe("a repository shared by two systems", () => {
    const memberships = membershipsByRepository([platform, checkout]);

    it("knows every environment each repository is part of", () => {
        expect(memberships.get("r-auth")).toEqual([
            {
                environmentId: "env-platform",
                name: "app",
                role: "member",
                triggers: true,
            },
            {
                environmentId: "env-checkout",
                name: "storefront",
                role: "member",
                triggers: false,
            },
        ]);
        expect(
            otherEnvironmentsOf(memberships, "r-auth", "env-platform").map(
                (m) => m.name,
            ),
        ).toEqual(["storefront"]);
        expect(
            otherEnvironmentsOf(memberships, "r-billing", "env-platform"),
        ).toEqual([]);
    });

    it("tells a member's own settings that its mode governs only an environment of its own, and that turning it on creates one", () => {
        // demo-shop-billing on 2026-11-13: "On request" on a member created a second environment, unannounced.
        expect(ownModeNote(memberships.get("r-billing"))).toBe(
            "Its pull requests run in the environment of app, by that environment's settings. The mode here is for an environment of its own: turning it on creates one, with its own setup file and machines.",
        );
        const withOwn = membershipsByRepository([
            platform,
            env("env-billing", repo("r-billing", "acme/billing", "primary")),
        ]);
        expect(ownModeNote(withOwn.get("r-billing"))).toBe(
            "Its pull requests run in the environment of app, by that environment's settings. The mode here governs only its own environment.",
        );
        expect(ownModeNote(memberships.get("r-app"))).toBeUndefined();
        expect(ownModeNote(undefined)).toBeUndefined();
        // Part of an environment that does not run its PRs.
        expect(
            ownModeNote(membershipsByRepository([checkout]).get("r-auth")),
        ).toMatch(/^It is part of the environment of storefront\. /);
    });

    it("offers only connected repositories not in the environment, with where else they are", () => {
        const offered = addableRepositories(
            [
                { repositoryId: "r-app", repositoryName: "acme/app" },
                { repositoryId: "r-auth", repositoryName: "acme/auth-service" },
                {
                    repositoryId: "r-tokens",
                    repositoryName: "acme/Design Tokens",
                },
            ],
            checkout,
            memberships,
        );
        expect(offered).toEqual([
            {
                repositoryId: "r-app",
                name: "acme/app",
                defaultAlias: "app",
                alsoIn: ["app"],
            },
            {
                repositoryId: "r-tokens",
                name: "acme/Design Tokens",
                defaultAlias: "design-tokens",
                alsoIn: [],
            },
        ]);
    });
});

describe("the folder of a new repository", () => {
    it("is the API's default alias: the short name in lower case, one dash per run of other characters", () => {
        expect(defaultRepositoryAlias("acme/kodus-service-billing")).toBe(
            "kodus-service-billing",
        );
        expect(defaultRepositoryAlias("group/sub/My Repo!")).toBe("my-repo-");
        expect(defaultRepositoryAlias("acme/__")).toBe("repo");
    });

    it("refuses a folder the cell cannot use, or one another repository has", () => {
        const taken = [
            { alias: "app", name: "app" },
            { alias: "billing", name: "billing" },
        ];
        expect(aliasProblem("", taken)).toBe("Give it a folder name.");
        expect(aliasProblem("Billing", taken)).toMatch(/lower case/);
        expect(aliasProblem("../x", taken)).toMatch(/lower case/);
        expect(aliasProblem("app", taken)).toBe(
            "app already uses this folder.",
        );
        expect(aliasProblem("auth", taken)).toBeUndefined();
    });
});

describe("ten repositories at most", () => {
    it("is full at ten", () => {
        const members = Array.from({ length: 9 }, (_, i) =>
            repo(`m${i}`, `acme/m${i}`),
        );
        const primary = repo("p", "acme/p", "primary");
        expect(isEnvironmentFull(env("e", primary, members))).toBe(true);
        expect(isEnvironmentFull(env("e", primary, members.slice(1)))).toBe(
            false,
        );
    });
});

describe("namesInWords", () => {
    it("joins up to three names, then counts the rest", () => {
        expect(namesInWords([])).toBe("");
        expect(namesInWords(["a"])).toBe("a");
        expect(namesInWords(["a", "b"])).toBe("a and b");
        expect(namesInWords(["a", "b", "c"])).toBe("a, b and c");
        expect(namesInWords(["a", "b", "c", "d"])).toBe("a, b and 2 more");
    });
});

describe("repositoryChangeError", () => {
    it("shows the API's sentence for a conflict, and a plain line for a refusal", () => {
        expect(
            repositoryChangeError({
                statusCode: 409,
                body: {
                    message:
                        "The primary repository's alias is fixed (app): it is derived from its name",
                },
            }),
        ).toBe(
            "The primary repository's alias is fixed (app): it is derived from its name",
        );
        expect(repositoryChangeError({ statusCode: 403 })).toMatch(
            /Only the owner of the organization/,
        );
        expect(repositoryChangeError({ statusCode: 500 })).toMatch(/Try again/);
    });
});

describe("what ran on each side of a multi-repository Run", () => {
    const sha = (c: string) => c.repeat(40);
    const workspace: RunWorkspaceRef[] = [
        {
            repositoryId: "r-auth",
            alias: "auth",
            baseSha: sha("4"),
            headSha: sha("4"),
            source: "default_branch",
            branch: "main",
        },
        {
            repositoryId: "r-billing",
            alias: "billing",
            baseSha: sha("9"),
            headSha: sha("8"),
            source: "paired",
            pairedPrNumber: 77,
            branch: "feat/invoices",
        },
        {
            repositoryId: "r-app",
            alias: "app",
            baseSha: sha("7"),
            headSha: sha("e"),
            source: "pull_request",
            branch: "feat/invoices",
        },
    ];
    const run = {
        workspace,
        prNumber: 482,
        baseBranch: "main",
        requestedAt: new Date(2026, 10, 11, 14, 2).toISOString(),
    };

    it("lists the PR's repository first, then a paired one, then the ones fixed at their default branch", () => {
        const rows = workspaceSideRows(
            run,
            new Map([
                ["r-app", "app"],
                ["r-billing", "billing-service"],
            ]),
        );
        expect(rows.map((r) => [r.name, r.base, r.pr, r.why, r.same])).toEqual([
            [
                "app",
                { sha: "7777777", label: "main" },
                { sha: "eeeeeee", label: "#482" },
                "The pull request",
                false,
            ],
            [
                "billing-service",
                { sha: "9999999", label: "base" },
                { sha: "8888888", label: "#77" },
                "Paired with #77, its pull request from feat/invoices",
                false,
            ],
            [
                // Removed from the environment since: its folder names it.
                "auth",
                { sha: "4444444", label: "main" },
                { sha: "4444444", label: "main" },
                "Default branch, fixed at 14:02 when the Run started",
                true,
            ],
        ]);
        expect(pullRequestBranchOf(workspace)).toBe("feat/invoices");
    });

    it("is nothing for a Run of one repository", () => {
        expect(workspaceSideRows({ prNumber: 1 })).toEqual([]);
        expect(workspaceSideRows({ prNumber: 1, workspace: [] })).toEqual([]);
    });

    it("gives the PR card the other repositories and the commit their PR side booted", () => {
        expect(ranWithOf({ workspace })).toEqual([
            { alias: "auth", sha: sha("4"), from: "main" },
            { alias: "billing", sha: sha("8"), from: "#77" },
        ]);
        expect(ranWithOf(null)).toEqual([]);
        expect(ranWithOf({})).toEqual([]);
    });
});

describe("after a change of the repositories", () => {
    it("keeps the commit of the last setup the change answer does not carry", () => {
        const before = [
            repo("r1", "acme/app", "primary", { lastSetupSha: "a".repeat(40) }),
            repo("r2", "acme/billing", "member", {
                lastSetupSha: "b".repeat(40),
            }),
        ];
        const answered = [
            repo("r1", "acme/app", "primary"),
            repo("r2", "acme/billing", "member", { triggers: false }),
            repo("r3", "acme/auth"),
        ];
        const next = withRepositoriesAnswer(before, answered);
        expect(next.map((r) => r.lastSetupSha)).toEqual([
            "a".repeat(40),
            "b".repeat(40),
            undefined,
        ]);
        expect(next[1].triggers).toBe(false);
    });
});

describe("who may act on a multi-repository system", () => {
    it("an environment's action needs every repository it boots, the primary alone for one", () => {
        expect(
            repositoryIdsOfEnvironment({
                repositoryId: "r1",
                repositories: [
                    repo("r2", "acme/billing"),
                    repo("r1", "acme/app", "primary"),
                ],
            }),
        ).toEqual(["r1", "r2"]);
        expect(repositoryIdsOfEnvironment({ repositoryId: "r1" })).toEqual([
            "r1",
        ]);
    });

    it("a Run's action needs every repository the Run booted, its own once", () => {
        const ref = (repositoryId: string) =>
            ({ repositoryId }) as RunWorkspaceRef;
        expect(
            repositoryIdsOfRun({
                repositoryId: "r1",
                workspace: [ref("r1"), ref("r2")],
            }),
        ).toEqual(["r1", "r2"]);
        expect(repositoryIdsOfRun({ repositoryId: "r1" })).toEqual(["r1"]);
    });
});
