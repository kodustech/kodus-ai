import { byokFailureCopy } from "./byok-failure-copy";

/**
 * #1871: the banner said "often an insufficient balance or a suspended/expired
 * account" for every failure. A customer with credit and an active key was
 * rate limited on a free model and went looking at billing. The wording has to
 * follow what the provider actually answered, and not guess when it is unknown.
 */
describe("byokFailureCopy", () => {
    const billing = /balance|suspended|expired|credit/i;

    it("does not blame billing for a rate limit", () => {
        const { title, body } = byokFailureCopy("OpenRouter", "RATE_LIMIT");
        expect(`${title} ${body}`).not.toMatch(billing);
        expect(`${title} ${body}`).toMatch(/rate limit/i);
    });

    it("does not blame a free model: the copy cannot tell which model it is", () => {
        const { title, body } = byokFailureCopy("Anthropic", "RATE_LIMIT");
        expect(`${title} ${body}`).not.toMatch(/free/i);
    });

    it("does not guess a cause when the error was not classified", () => {
        for (const category of [undefined, "UNKNOWN", "TRANSIENT"]) {
            const { title, body } = byokFailureCopy("OpenRouter", category);
            expect(`${title} ${body}`).not.toMatch(billing);
            expect(title).not.toMatch(/key is failing/i);
        }
    });

    it("points at the model setting when the provider cannot serve it", () => {
        for (const category of ["MODEL_NOT_FOUND", "MODEL_ACCESS_DENIED"]) {
            const { body } = byokFailureCopy("OpenRouter", category);
            expect(body).toMatch(/model/i);
            expect(body).not.toMatch(billing);
        }
    });

    it("does not send a pinned-provider refusal to the model id or the key", () => {
        // OpenRouter's 404 when the pinned/allowed providers serve no upstream
        // for the model: same category as a wrong id, different fix.
        const said =
            "No allowed providers are available for the selected model.";
        const { title, body } = byokFailureCopy(
            "OpenRouter",
            "MODEL_NOT_FOUND",
            said,
        );
        expect(`${title} ${body}`).toMatch(/allow/i);
        expect(body).not.toMatch(/check the model id/i);
        expect(title).not.toMatch(/key/i);
        expect(`${title} ${body}`).not.toMatch(billing);
    });

    it("still points at the model id for a genuinely missing model", () => {
        const { body } = byokFailureCopy(
            "OpenRouter",
            "MODEL_NOT_FOUND",
            'model "gpt-nope" does not exist',
        );
        expect(body).toMatch(/check the model id/i);
    });

    it("keeps the billing hint where it is the cause", () => {
        expect(byokFailureCopy("OpenAI", "QUOTA_EXCEEDED").body).toMatch(
            /balance|credit|quota/i,
        );
    });

    it("blames the key only when the provider rejected it", () => {
        expect(byokFailureCopy("OpenAI", "AUTH_INVALID").title).toMatch(/key/i);
    });
});
