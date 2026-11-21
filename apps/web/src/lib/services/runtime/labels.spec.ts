import { RUN_STATES } from "./contracts";
import {
    blockerKindLabel,
    canApprove,
    canRunAgain,
    cellOwnerLabel,
    cellStatusLabel,
    checkConclusionLabel,
    isCheckFinal,
    isRunState,
    isTerminalRunState,
    RUN_PATH_OUTCOME_META,
    runStateLabel,
    runStateTone,
    runtimeModeLabel,
    setupStepLabel,
    setupStepStateLabel,
    TERMINAL_RUN_STATES,
    verdictChipLabel,
    verdictLabel,
} from "./labels";

describe("Run state labels", () => {
    it("says what the check says for each verdict state", () => {
        expect(runStateLabel("no_regressions")).toBe("No regressions");
        expect(runStateLabel("partly_tested")).toBe("Partly tested");
        expect(runStateLabel("could_not_boot")).toBe("Could not boot");
        expect(runStateLabel("awaiting_approval")).toBe(
            "Waiting for a maintainer",
        );
        expect(runStateLabel("errored")).toBe("Could not finish");
    });

    it("says nothing was tested instead of 'Partly tested' when no path was", () => {
        expect(verdictChipLabel("partly_tested", 0)).toBe("Nothing tested");
        expect(verdictChipLabel("partly_tested", 2)).toBe("Partly tested");
        expect(verdictChipLabel("could_not_boot", 0)).toBe("Could not boot");
    });

    it("has a label and a tone for every state of the lifecycle", () => {
        for (const state of RUN_STATES) {
            expect(runStateLabel(state)).not.toBe(state);
            expect(runStateTone(state)).toBeDefined();
        }
    });

    it("prints an unknown state as it came instead of hiding it", () => {
        expect(runStateLabel("paused")).toBe("paused");
        expect(runStateTone("paused")).toBe("neutral");
    });

    it("never colours a regression or a halt as anything but danger", () => {
        expect(runStateTone("regression")).toBe("danger");
        expect(runStateTone("halted")).toBe("danger");
        expect(runStateTone("no_regressions")).toBe("success");
    });
});

describe("Run again", () => {
    it("is offered only once the Run is terminal", () => {
        for (const state of [
            "queued",
            "awaiting_approval",
            "booting",
            "testing",
        ] as const) {
            expect(isTerminalRunState(state)).toBe(false);
            expect(canRunAgain(state)).toBe(false);
        }
        for (const state of [
            "timed_out",
            "errored",
            "regression",
            "halted",
        ] as const) {
            expect(canRunAgain(state)).toBe(true);
        }
    });
});

describe("isCheckFinal", () => {
    it("hides the placeholder check the API derives for a live Run", () => {
        expect(isCheckFinal("testing")).toBe(false);
        expect(isCheckFinal("queued")).toBe(false);
        expect(isCheckFinal("awaiting_approval")).toBe(true);
        expect(isCheckFinal("partly_tested")).toBe(true);
    });
});

describe("check conclusion label", () => {
    it("maps the GitHub conclusion to words", () => {
        expect(checkConclusionLabel("action_required")).toBe("Action required");
        expect(checkConclusionLabel("timed_out")).toBe("Timed out");
    });
});

describe("approval", () => {
    it("is offered only to a Run waiting for a maintainer", () => {
        expect(canApprove("awaiting_approval")).toBe(true);
        expect(canApprove("queued")).toBe(false);
        expect(canApprove("regression")).toBe(false);
    });
});

describe("the other enums the screens print", () => {
    it("derives the terminal states from the same table as the labels", () => {
        expect([...TERMINAL_RUN_STATES].sort()).toEqual(
            RUN_STATES.filter((s) => isTerminalRunState(s)).sort(),
        );
        expect(TERMINAL_RUN_STATES.has("testing")).toBe(false);
        expect(TERMINAL_RUN_STATES.has("halted")).toBe(true);
    });

    it("does not read inherited object keys as states", () => {
        expect(isRunState("toString")).toBe(false);
        expect(runStateLabel("constructor")).toBe("constructor");
    });

    it("prints setup steps, blocker kinds, cells and modes in words", () => {
        expect(setupStepLabel("bake")).toBe("Bake the image");
        expect(setupStepLabel("recipe")).toBe("Read the setup file");
        expect(setupStepStateLabel("done")).toBe("Done");
        expect(blockerKindLabel("missing_env")).toBe("Missing variable");
        expect(blockerKindLabel("security_violation")).toBe(
            "Security violation",
        );
        expect(blockerKindLabel("no_recipe")).toBe("No setup file");
        expect(blockerKindLabel("brand_new")).toBe("brand_new");
        expect(cellStatusLabel("connected")).toBe("Connected");
        expect(cellOwnerLabel("customer")).toBe("Your cloud");
        expect(cellOwnerLabel(undefined)).toBe("Kodus cloud");
        expect(runtimeModeLabel("on_request")).toBe("On request");
    });
});

describe("Path and verdict labels", () => {
    it("says what matched, not where the code is: pre_existing says it fails on main too", () => {
        expect(verdictLabel("pre_existing")).toBe(
            "Same on both versions, not as expected",
        );
        expect(RUN_PATH_OUTCOME_META.pre_existing.label).toBe(
            "Same on both versions, not as expected",
        );
        expect(RUN_PATH_OUTCOME_META.intended.label).toBe(
            "Changed, as the PR intends",
        );
        expect(RUN_PATH_OUTCOME_META.could_not_test.label).toBe("Not tested");
    });
});
