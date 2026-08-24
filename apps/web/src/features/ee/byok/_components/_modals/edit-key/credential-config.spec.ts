import type { z } from "zod";

import {
    PROVIDER_SETTING_KEYS,
    providerOwnsField,
    refineProviderCredentials,
} from "./credential-config";
import type { EditKeyForm } from "./_types";

const data = (over: Partial<EditKeyForm>): EditKeyForm =>
    ({ provider: "openai", model: "m", apiKey: "", ...over }) as EditKeyForm;

const makeCtx = () => {
    const issues: Array<{ path: (string | number)[]; message: string }> = [];
    const ctx = {
        addIssue: (i: { path?: (string | number)[]; message: string }) =>
            issues.push({ path: i.path ?? [], message: i.message }),
    } as unknown as z.RefinementCtx;
    return { ctx, issues };
};

describe("credential-config — provider-owned web credential wiring", () => {
    describe("providerOwnsField / PROVIDER_SETTING_KEYS", () => {
        it("Bedrock owns the aws* fields, not other providers", () => {
            expect(providerOwnsField("amazon_bedrock", "awsRegion")).toBe(true);
            expect(providerOwnsField("openai", "awsRegion")).toBe(false);
        });

        it("Vertex owns vertexLocation; OpenRouter owns its routing fields", () => {
            expect(providerOwnsField("google_vertex", "vertexLocation")).toBe(
                true,
            );
            expect(
                providerOwnsField("open_router", "openrouterProviderOrder"),
            ).toBe(true);
        });

        it("an unknown/undefined provider owns nothing", () => {
            expect(providerOwnsField(undefined, "awsRegion")).toBe(false);
            expect(providerOwnsField("nope", "vertexLocation")).toBe(false);
        });

        it("registry keys stay in sync with the aws* set", () => {
            expect(PROVIDER_SETTING_KEYS.amazon_bedrock).toContain(
                "awsSecretAccessKey",
            );
        });
    });

    describe("refineProviderCredentials", () => {
        it("defers (returns false) for a provider with no bespoke rules", () => {
            const { ctx, issues } = makeCtx();
            expect(refineProviderCredentials(data({ provider: "openai" }), ctx)).toBe(
                false,
            );
            expect(issues).toHaveLength(0);
        });

        it("Bedrock: a bearer token satisfies it (handled, no issues)", () => {
            const { ctx, issues } = makeCtx();
            expect(
                refineProviderCredentials(
                    data({ provider: "amazon_bedrock", awsBearerToken: "ABSK" }),
                    ctx,
                ),
            ).toBe(true);
            expect(issues).toHaveLength(0);
        });

        it("Bedrock: partial IAM flags the missing secret on its own field", () => {
            const { ctx, issues } = makeCtx();
            refineProviderCredentials(
                data({ provider: "amazon_bedrock", awsAccessKeyId: "AKIA" }),
                ctx,
            );
            expect(issues.map((i) => i.path[0])).toContain("awsSecretAccessKey");
        });

        it("Bedrock: nothing filled nudges toward the API key", () => {
            const { ctx, issues } = makeCtx();
            refineProviderCredentials(data({ provider: "amazon_bedrock" }), ctx);
            expect(issues[0]?.path[0]).toBe("awsBearerToken");
        });
    });
});
