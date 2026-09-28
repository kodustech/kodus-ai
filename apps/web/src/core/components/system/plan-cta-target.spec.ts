/** @jest-environment node */
describe("planCtaTarget", () => {
    afterEach(() => {
        jest.resetModules();
    });

    const load = async (nodeEnv: string) => {
        jest.resetModules();
        jest.doMock("src/core/utils/self-hosted", () => ({
            isSelfHosted: nodeEnv === "self-hosted",
        }));
        return import("./plan-cta-target");
    };

    it("sends a cloud org to the plan chooser", async () => {
        const { planCtaTarget, unlockedByLabel, availabilityLine } =
            await load("development");

        expect(planCtaTarget()).toEqual({
            href: "/choose-plan",
            label: "See plans",
        });
        expect(unlockedByLabel()).toBe("Teams and Enterprise");
        expect(availabilityLine()).toBe("Available on Teams and Enterprise.");
    });

    it("sends a self-hosted install to its license key, not to Stripe", async () => {
        // A self-hosted operator who lands on /choose-plan gets a screen
        // built around a checkout they cannot reach — capability there
        // comes from a license key.
        const { planCtaTarget, unlockedByLabel, availabilityLine } =
            await load("self-hosted");

        expect(planCtaTarget()).toEqual({
            href: "/settings/subscription",
            label: "Activate a license",
        });
        expect(unlockedByLabel()).toBe("an Enterprise license");
        expect(availabilityLine()).toBe(
            "Available with an Enterprise license.",
        );
    });
});
