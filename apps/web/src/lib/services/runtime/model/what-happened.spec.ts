import {
    bootFailureRun,
    healthRegressionRun,
    healthRegressionView,
    newRouteRun,
    newRouteView,
} from "./__fixtures__/run-detail";
import { bootFailureOf } from "./boot-failure";
import { codeRefOf } from "./code-ref";
import { buildFindings } from "./findings";
import { plainText } from "./rich-text";
import { whatHappened } from "./what-happened";

const healthFinding = (patch: Parameters<typeof healthRegressionRun>[0] = {}) =>
    buildFindings(healthRegressionRun(patch), healthRegressionView().steps)[0];

const text = (sentences: ReturnType<typeof whatHappened>) =>
    sentences.map(plainText).join(" ");

describe("whatHappened", () => {
    it("says the answers, the first difference and where the code changed", () => {
        const f = healthFinding();
        const story = whatHappened(f, { codeRef: codeRefOf(f.diffRef) });
        expect(text(story)).toBe(
            "GET /api/health answered 503 on this PR and 200 on main. " +
                "First difference: app log database is locked at +12 ms " +
                '(main: logger=context msg="Request Completed" method=GET path=/api/health status=200). ' +
                "Changed in pkg/api/health.go:23.",
        );
        expect(story[0]).toContainEqual({ strong: "503" });
    });

    it("names the fields when the status is the same", () => {
        const run = healthRegressionRun();
        const steps = healthRegressionView().steps.map((s) =>
            s.status === 503 ? { ...s, status: 200 } : s,
        );
        const f = buildFindings(run, steps)[0];
        expect(plainText(whatHappened(f)[0])).toBe(
            'GET /api/health answered 200 on both, but json.database went from "ok" on main to "failing" and json.commit is gone on this PR (main: "ee53311").',
        );
    });

    it("falls back to the differing field names on an older Run", () => {
        const f = healthFinding();
        const old = {
            ...f,
            responseDiff: undefined,
            lanes: undefined,
            diffRef: undefined,
        };
        const same = {
            ...old,
            pr: { ...old.pr, answer: "200" },
        };
        expect(text(whatHappened(same))).toBe(
            "GET /api/health answered 200 on both, but json.database differs.",
        );
        expect(text(whatHappened(old))).toBe(
            "GET /api/health answered 503 on this PR and 200 on main.",
        );
    });

    it("says a PR boot regression with the boot failure's title and error", () => {
        const boot = bootFailureOf(bootFailureRun({ state: "regression" }));
        const f = {
            ...healthFinding(),
            entryPoint: "boot",
            route: "boot",
            destabilizes: true,
            boot: true,
            lanes: undefined,
        };
        const story = text(whatHappened(f, { bootFailure: boot }));
        expect(story).toMatch(
            /^main booted and this PR did not: The build checks github\.com\/Masterminds\/semver\/v3@v3\.4\.0 against the Go checksum database, which the sandbox does not reach\.$/,
        );
        expect(text(whatHappened(f))).toBe("main booted and this PR did not.");
    });

    it("says a first difference only main has", () => {
        const f = healthFinding();
        const fd = f.lanes!.firstDifference!;
        const story = whatHappened({
            ...f,
            lanes: { ...f.lanes!, firstDifference: { ...fd, pr: undefined } },
        });
        expect(plainText(story[1])).toBe(
            'First difference: main\'s app log logger=context msg="Request Completed" method=GET path=/api/health status=200 at +9 ms has no match on this PR.',
        );
    });

    it("is empty when the record holds nothing to say", () => {
        const f = healthFinding();
        expect(
            whatHappened({
                ...f,
                base: { ...f.base, answer: "not recorded" },
                pr: { ...f.pr, answer: "not recorded" },
                differingFields: [],
                responseDiff: undefined,
                lanes: undefined,
            }),
        ).toEqual([]);
    });

    it("does not call the request the first difference when only its answer differs", () => {
        const [f] = buildFindings(newRouteRun(), newRouteView().steps);
        expect(text(whatHappened(f))).toBe(
            "GET /orders/export answered 200 on this PR and 404 on main.",
        );
    });
});
