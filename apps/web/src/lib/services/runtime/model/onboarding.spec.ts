import { onboardingState } from "./onboarding";

const env = (id: string, state: any, setup?: any) => ({
    environmentId: id,
    repositoryId: `r-${id}`,
    repositoryName: `acme/${id}`,
    state,
    setup,
});

describe("onboardingState", () => {
    it("starts at picking a repository when there is no environment", () => {
        expect(onboardingState([])).toEqual({ step: "pick" });
    });

    it("watches the setup still moving, and says when the first one is blocked", () => {
        const busy = env("a", "setting_up", { state: "setting_up" });
        const blocked = env("b", "blocked", { state: "blocked" });
        expect(onboardingState([blocked, busy])).toMatchObject({
            step: "watch",
            environment: busy,
            blocked: false,
        });
        expect(onboardingState([blocked])).toMatchObject({
            step: "watch",
            environment: blocked,
            blocked: true,
        });
    });

    it("asks for a pull request test once one is ready and its repository has no Run", () => {
        const ready = env("a", "active", { state: "active" });
        expect(onboardingState([ready], false)).toEqual({
            step: "test",
            environment: ready,
        });
        expect(onboardingState([ready], true)).toBeUndefined();
        // Unknown (loading or failed): the table, never a trap.
        expect(onboardingState([ready])).toBeUndefined();
    });

    it("an active row never set up is not ready", () => {
        expect(onboardingState([env("a", "active")])).toMatchObject({
            step: "watch",
        });
    });

    it("shows the table from three environments on, ready or not", () => {
        const busy = (id: string) => env(id, "setting_up", { state: "setting_up" });
        expect(onboardingState([busy("a"), busy("b"), busy("c")])).toBeUndefined();
    });
});
