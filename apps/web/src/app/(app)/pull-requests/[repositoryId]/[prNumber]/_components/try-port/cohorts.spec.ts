import { buildCohorts, classifyCohort, type CohortKey } from "./cohorts";
import type { DiffFile } from "./types";

const file = (path: string, additions = 3, deletions = 1): DiffFile => ({
    path,
    oldPath: null,
    status: "modified",
    additions,
    deletions,
});

describe("classifyCohort", () => {
    const cases: [string, CohortKey][] = [
        // Contracts & types — the surface others depend on.
        ["libs/x/contracts/CommentManagerService.contract.ts", "contracts"],
        ["libs/x/dtos/pull-request.dto.ts", "contracts"],
        ["libs/x/interfaces/pr.interface.ts", "contracts"],
        ["libs/x/schemas/mongoose/pr.model.ts", "contracts"],
        ["api/openapi.yaml", "contracts"],
        ["proto/service.proto", "contracts"],
        ["shared/global.d.ts", "contracts"],
        // Migrations.
        ["libs/db/migrations/2026042000000-Init.ts", "migrations"],
        ["db/schema.sql", "migrations"],
        // Implementation (fallback for source code).
        ["apps/web/src/app/page.tsx", "implementation"],
        ["libs/foo/bar.service.ts", "implementation"],
        ["worker/main.py", "implementation"],
        ["cmd/server/main.go", "implementation"],
        // Tests — must win over the directory a test lives in.
        ["apps/web/src/x/foo.spec.ts", "tests"],
        ["tests/e2e/lib/runner.test.ts", "tests"],
        ["src/__tests__/thing.ts", "tests"],
        ["src/button.stories.tsx", "tests"],
        ["libs/x/contracts/foo.spec.ts", "tests"],
        // Config & CI.
        [".github/workflows/ci.yml", "config"],
        ["Dockerfile", "config"],
        ["package.json", "config"],
        ["tsconfig.json", "config"],
        ["pnpm-lock.yaml", "config"],
        ["apps/web/next.config.js", "config"],
        ["k8s/deploy.yaml", "config"],
        ["infra/random.yml", "config"],
        // Styles.
        ["apps/web/src/globals.css", "styles"],
        ["ui/theme.scss", "styles"],
        // Docs.
        ["docs/how_to/byok.mdx", "docs"],
        ["README.md", "docs"],
        ["LICENSE", "docs"],
        // Anything unrecognized.
        ["assets/logo.png", "other"],
        ["data/fixture.json", "other"],
    ];

    it.each(cases)("classifies %s as %s", (path, want) => {
        expect(classifyCohort(path)).toBe(want);
    });

    it("treats a spec file inside contracts/ as a test, not a contract", () => {
        // Precedence regression: the role-specific signal (spec) wins over the
        // directory (contracts). Getting this backwards buries tests under the
        // contract layer.
        expect(classifyCohort("libs/x/contracts/thing.spec.ts")).toBe("tests");
    });

    it("treats a root tsconfig.json as config, not implementation", () => {
        expect(classifyCohort("tsconfig.json")).toBe("config");
    });
});

describe("buildCohorts", () => {
    it("orders groups by reading order and drops empty ones", () => {
        const files = [
            file("README.md"),
            file("apps/web/src/foo.service.ts"),
            file("libs/x/dtos/foo.dto.ts"),
            file("apps/web/src/foo.spec.ts"),
        ];
        const keys = buildCohorts(files).map((c) => c.meta.key);
        // contracts before implementation before tests before docs; no empty
        // groups (migrations/styles/config/other absent).
        expect(keys).toEqual(["contracts", "implementation", "tests", "docs"]);
    });

    it("aggregates additions/deletions per group", () => {
        const cohorts = buildCohorts([
            file("libs/a/x.dto.ts", 10, 2),
            file("libs/b/y.schema.ts", 5, 3),
        ]);
        expect(cohorts).toHaveLength(1);
        expect(cohorts[0].meta.key).toBe("contracts");
        expect(cohorts[0].additions).toBe(15);
        expect(cohorts[0].deletions).toBe(5);
    });

    it("sorts files within a group by path", () => {
        const cohorts = buildCohorts([
            file("libs/z.service.ts"),
            file("libs/a.service.ts"),
        ]);
        expect(cohorts[0].files.map((f) => f.path)).toEqual([
            "libs/a.service.ts",
            "libs/z.service.ts",
        ]);
    });

    it("prefers a backend-supplied cohort hint over the heuristic", () => {
        // Paves the Kody-decided path: a file carrying its own cohort wins.
        const hinted = {
            ...file("libs/x/foo.service.ts"),
            cohort: "contracts",
        } as DiffFile & { cohort: string };
        expect(buildCohorts([hinted])[0].meta.key).toBe("contracts");
    });

    it("ignores an unknown hint and falls back to the classifier", () => {
        const hinted = {
            ...file("libs/x/foo.service.ts"),
            cohort: "nonsense",
        } as DiffFile & { cohort: string };
        expect(buildCohorts([hinted])[0].meta.key).toBe("implementation");
    });
});
