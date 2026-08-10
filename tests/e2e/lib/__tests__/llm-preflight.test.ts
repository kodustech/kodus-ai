import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyLlmError, describeLlmPreflight } from "../llm-preflight.js";

// Real provider bodies. Classifying rather than passing the raw text through
// matters because the FIX differs per class, and the provider's own wording
// blurs "no balance" with "spend cap reached" — both of which arrive as the
// same sentence.
test("quota: OpenAI insufficient_quota", () => {
    assert.equal(
        classifyLlmError(
            429,
            '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
        ),
        "quota",
    );
});

test("quota: prepaid balance drained", () => {
    assert.equal(
        classifyLlmError(
            400,
            '{"error":{"message":"You have no credits remaining. Add credits to continue"}}',
        ),
        "quota",
    );
});

test("auth: rejected key", () => {
    assert.equal(
        classifyLlmError(
            401,
            '{"error":{"message":"Incorrect API key provided: sk-svc***"}}',
        ),
        "auth",
    );
});

// The case that made this file worth writing: a model id nobody could confirm
// from the repo. Misreporting it as a billing problem would send someone to
// the wrong dashboard.
test("model: unknown id is not reported as a billing problem", () => {
    assert.equal(
        classifyLlmError(
            404,
            '{"error":{"code":"model_not_found","message":"The model `gpt-9` does not exist"}}',
        ),
        "model",
    );
});

test("model: entitlement, not existence", () => {
    assert.equal(
        classifyLlmError(
            403,
            '{"error":{"message":"You do not have access to model gpt-5.6"}}',
        ),
        "model",
    );
});

test("unknown: a 5xx is the provider's problem, not a verdict on the key", () => {
    assert.equal(classifyLlmError(500, "upstream error"), "unknown");
});

test("each class points at where the fix lives", () => {
    assert.match(
        describeLlmPreflight({ status: "quota", model: "m" }),
        /billing/i,
    );
    assert.match(
        describeLlmPreflight({ status: "auth", model: "m" }),
        /BYOK_OPENAI_API_KEY/,
    );
    assert.match(
        describeLlmPreflight({ status: "model", model: "gpt-x" }),
        /E2E_LLM_MODEL/,
    );
});

// Our own probe caps the response; a reasoning model spends output budget
// before emitting text and returns 400 for it. That is the request SUCCEEDING
// as far as key and model are concerned — treating it as a failure would have
// the preflight block runs on nothing.
test("ok: hitting our own output cap is not a failure", () => {
    assert.equal(
        classifyLlmError(
            400,
            '{"error":{"message":"Could not finish the message because max_tokens or model output limit was reached. Please try again with higher max_tokens.","type":"invalid_request_error"}}',
        ),
        "ok",
    );
});
