import { TASK_LABELS } from "../../byok/_utils";
import { TASK_META, taskKeyOf } from "./task-meta";

describe("token usage task meta", () => {
    it("keeps custom agent spend as its own tasks (#2172)", () => {
        // An unknown task folds into "" (Unrouted) and the per-task view skips
        // it, so custom agent spend vanished from "Where tokens go".
        expect(taskKeyOf("customAgent")).toBe("customAgent");
        expect(taskKeyOf("customAgentCheck")).toBe("customAgentCheck");
    });

    it("labels every routing task the routing screen knows", () => {
        for (const task of Object.keys(TASK_LABELS)) {
            expect(TASK_META[task]?.label).toBeTruthy();
            expect(TASK_META[task]?.description).toBeTruthy();
        }
    });

    it("names the custom agent tasks the way the routing screen does", () => {
        expect(TASK_META.customAgent.label).toBe(TASK_LABELS.customAgent);
        expect(TASK_META.customAgentCheck.label).toBe(
            TASK_LABELS.customAgentCheck,
        );
    });

    it("tells the check apart from the agents themselves", () => {
        expect(TASK_LABELS.customAgentCheck).toBe("Custom Agents: finding check");
        expect(TASK_META.customAgentCheck.description).toMatch(/second pass/i);
    });

    it("still folds an unknown task into Unrouted", () => {
        expect(taskKeyOf("somethingElse")).toBe("");
        expect(taskKeyOf("codeReview")).toBe("codeReview");
    });
});
