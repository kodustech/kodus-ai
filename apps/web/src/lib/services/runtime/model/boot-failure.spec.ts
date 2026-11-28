import {
    BOOT_TITLE,
    bootFailureRun,
    SUMDB_ERROR_LINE,
    sumdbBootFailure,
} from "./__fixtures__/run-detail";
import {
    bootFailureDetailOf,
    bootFailureOf,
    bootTailPreview,
    isKodusSideBootFailure,
} from "./boot-failure";

describe("bootFailureOf", () => {
    it("shows the PR's boot failure on a partly tested Run, error line highlighted", () => {
        const view = bootFailureOf(bootFailureRun());
        expect(view).toMatchObject({
            side: "pr",
            sideLabel: "this PR",
            title: BOOT_TITLE,
            kindLabel: expect.any(String),
            errorLine: SUMDB_ERROR_LINE,
            errorInTail: true,
        });
        expect(view?.lines.filter((l) => l.error)).toEqual([
            { key: "5", text: `#12 12.03 ${SUMDB_ERROR_LINE}`, error: true },
        ]);
    });

    it("shows it on could_not_boot for either side, and on a PR boot regression", () => {
        const base = { ...sumdbBootFailure(), side: "base" as const };
        expect(
            bootFailureOf(
                bootFailureRun({ state: "could_not_boot", bootFailure: base }),
            )?.sideLabel,
        ).toBe("main");
        expect(
            bootFailureOf(bootFailureRun({ state: "regression" }))?.side,
        ).toBe("pr");
    });

    it("stays hidden where the boot is not the story", () => {
        expect(
            bootFailureOf(bootFailureRun({ state: "no_regressions" })),
        ).toBeUndefined();
        expect(
            bootFailureOf(
                bootFailureRun({
                    state: "partly_tested",
                    bootFailure: { ...sumdbBootFailure(), side: "base" },
                }),
            ),
        ).toBeUndefined();
        expect(
            bootFailureOf(bootFailureRun({ bootFailure: undefined })),
        ).toBeUndefined();
    });

    it("reads bootFailureDetail when bootFailure is not there", () => {
        const run = bootFailureRun({
            bootFailure: undefined,
            bootFailureDetail: sumdbBootFailure(),
        });
        expect(bootFailureDetailOf(run)?.signature).toBe(
            "platform:go_checksum_db",
        );
        expect(bootFailureOf(run)?.title).toContain("Go checksum database");
    });

    it("ignores a malformed detail and keeps the error line when the tail lacks it", () => {
        expect(
            bootFailureDetailOf({
                bootFailure: { side: "pr" } as never,
                bootFailureDetail: undefined,
            }),
        ).toBeUndefined();
        const view = bootFailureOf(
            bootFailureRun({
                bootFailure: { ...sumdbBootFailure(), logTail: ["exit 1"] },
            }),
        );
        expect(view?.errorInTail).toBe(false);
        expect(view?.errorLine).toBe(SUMDB_ERROR_LINE);
    });
});

describe("bootTailPreview", () => {
    it("keeps the last lines and always the error line", () => {
        const view = bootFailureOf(bootFailureRun())!;
        expect(bootTailPreview(view, 4).map((l) => l.key)).toEqual([
            "5",
            "7",
            "8",
            "9",
        ]);
        expect(bootTailPreview(view, 6).map((l) => l.key)).toEqual([
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
        ]);
        expect(bootTailPreview({ lines: [] })).toEqual([]);
    });
});

describe("isKodusSideBootFailure", () => {
    it("reads Kodus's own steps and the sandbox's reach as Kodus's side", () => {
        expect(
            isKodusSideBootFailure({
                kind: "platform",
                signature: "repo_fetch",
            }),
        ).toBe(true);
        expect(isKodusSideBootFailure(sumdbBootFailure())).toBe(true);
        expect(bootFailureOf(bootFailureRun())?.kodusSide).toBe(true);
    });

    it("leaves a cause in the repository or its setup to the developer", () => {
        expect(
            isKodusSideBootFailure({
                kind: "toolchain",
                signature: "toolchain:go",
            }),
        ).toBe(false);
        // Classified platform, but the app binds to 127.0.0.1: the developer's fix.
        expect(
            isKodusSideBootFailure({
                kind: "platform",
                signature: "platform:not_listening:web:3000",
            }),
        ).toBe(false);
        expect(isKodusSideBootFailure(undefined)).toBe(false);
    });

    it("shows the capacity card of a Run that timed out waiting for a host, and no other timed out Run's", () => {
        const f = { side: "pr" as const, kind: "resources" as const, signature: "no_capacity", title: "Every host that can run this environment is full", logTail: [], at: "2026-11-17T12:30:00.000Z" };
        // Nothing in the repository to change: the page titles it as Kodus's side and links no setup file.
        expect(bootFailureOf({ state: "timed_out", bootFailure: f })).toMatchObject({ title: "Every host that can run this environment is full", kodusSide: true });
        expect(bootFailureOf({ state: "timed_out", bootFailure: { ...f, signature: "boot_timeout" } })).toBeUndefined();
    });
});
