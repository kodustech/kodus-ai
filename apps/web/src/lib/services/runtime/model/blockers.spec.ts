import {
    blockerAnchorId,
    CONNECT_REPOSITORIES_HREF,
    groupBlockersBySignature,
    membershipFixOf,
    splitBlockersByFrequency,
} from "./blockers";

describe("groupBlockersBySignature", () => {
    it("keeps grouped rows, most frequent first", () => {
        const groups = groupBlockersBySignature([
            {
                signature: "a",
                kind: "toolchain",
                count: 1,
                lastAt: "2026-10-01T00:00:00Z",
            },
            {
                signature: "b",
                kind: "missing_env",
                count: 4,
                lastAt: "2026-09-01T00:00:00Z",
            },
        ]);
        expect(groups.map((g) => g.signature)).toEqual(["b", "a"]);
    });

    it("folds raw blockers of one signature into a single row with the last PR", () => {
        const groups = groupBlockersBySignature([
            {
                id: "1",
                environmentId: "env",
                kind: "external_service",
                signature: "stripe-down",
                title: "Stripe is unreachable",
                state: "open",
                seen: {
                    count: 2,
                    firstAt: "2026-10-01T00:00:00Z",
                    lastAt: "2026-10-02T00:00:00Z",
                    lastPr: 10,
                },
            },
            {
                id: "2",
                environmentId: "env",
                kind: "external_service",
                signature: "stripe-down",
                title: "Stripe is unreachable",
                state: "waiting_human",
                seen: {
                    count: 3,
                    firstAt: "2026-10-03T00:00:00Z",
                    lastAt: "2026-10-04T00:00:00Z",
                    lastPr: 12,
                },
            },
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({
            signature: "stripe-down",
            count: 5,
            lastAt: "2026-10-04T00:00:00Z",
            lastPr: 12,
            state: "waiting_human",
        });
    });
});

describe("Environment Health by frequency (screen 4)", () => {
    it("puts blockers seen 10 times or more apart from the rest", () => {
        const g = (signature: string, count: number) => ({
            signature,
            kind: "unknown" as const,
            count,
        });
        expect(
            splitBlockersByFrequency([
                g("a", 12),
                g("b", 10),
                g("c", 9),
                g("d", 1),
            ]),
        ).toEqual({
            frequent: [g("a", 12), g("b", 10)],
            occasional: [g("c", 9), g("d", 1)],
        });
    });
});

describe("blockerAnchorId", () => {
    it("is a safe DOM id for any signature", () => {
        expect(blockerAnchorId("npm ci/exit 1")).toBe("blocker-npm-ci-exit-1");
    });
});

describe("membershipFixOf (cards about the environment's repositories)", () => {
    it("adds a connected repository with the folder the recipe gives it", () => {
        expect(
            membershipFixOf({
                action: "add_repository",
                repositoryId: "repo-2",
                repository: "acme/billing",
                alias: "billing",
            }),
        ).toEqual({
            kind: "add",
            repositoryId: "repo-2",
            repository: "acme/billing",
            alias: "billing",
        });
    });

    it("sends a repository Kodus is not connected to to the Git settings", () => {
        expect(
            membershipFixOf({
                action: "connect_repository",
                repository: "acme/billing",
            }),
        ).toEqual({
            kind: "connect",
            repository: "acme/billing",
            href: CONNECT_REPOSITORIES_HREF,
        });
    });

    it("is nothing for any other fix, or an add without the repository to add", () => {
        expect(membershipFixOf({ action: "retry_setup" })).toBeUndefined();
        expect(
            membershipFixOf({ action: "add_repository", repository: "acme/x" }),
        ).toBeUndefined();
    });
});
