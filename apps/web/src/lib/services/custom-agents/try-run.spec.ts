import { pollTryRun, tryResultHeadline, type TryRunView } from "./try-run";

const trace = {
    status: "completed" as const,
    skillsOpened: [],
    toolCalls: [],
    findings: [],
};

describe("Try it run polling", () => {
    it("reads the run until it is done and returns its trace", async () => {
        const views: TryRunView[] = [
            { runId: "run-1", status: "running" },
            { runId: "run-1", status: "done", result: trace },
        ];
        const readRun = jest.fn(async () => views.shift()!);
        const wait = jest.fn(async () => undefined);

        await expect(
            pollTryRun({ runId: "run-1", status: "running" }, readRun, wait),
        ).resolves.toBe(trace);
        expect(readRun).toHaveBeenCalledTimes(2);
        expect(readRun).toHaveBeenCalledWith("run-1");
        expect(wait).toHaveBeenCalledTimes(2);
    });

    it("stops on a failed read instead of polling forever", async () => {
        const readRun = jest.fn().mockRejectedValue(new Error("404"));

        await expect(
            pollTryRun(
                { runId: "run-1", status: "running" },
                readRun,
                async () => undefined,
            ),
        ).rejects.toThrow("404");
    });
});

describe("Try it result headline", () => {
    it("says a run that stopped early stopped early, not completed", () => {
        expect(
            tryResultHeadline({
                ...trace,
                status: "incomplete",
                reason: "The agent stopped without submitting a result",
            }),
        ).toBe(
            "Stopped early · The agent stopped without submitting a result · 0 findings · 0 kept · 0 would post",
        );
    });

    it("counts findings for a completed run", () => {
        expect(tryResultHeadline(trace)).toBe(
            "0 findings · 0 kept · 0 would post",
        );
    });
});
