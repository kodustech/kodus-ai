import * as fs from "fs";
import * as path from "path";

/**
 * Static guard against a real production bug:
 *
 *   The `codeReviewConfigRemovePropertiesNotInType` helper in
 *   `apps/web/src/core/utils/helpers.ts` strips any field NOT present in
 *   its hardcoded `expectedKeys` whitelist before the payload reaches
 *   the backend.
 *
 *   When the IDE auto-sync toggle-off modal was added, we wired
 *   `ideSyncDisableAction` into the payload and the
 *   `CodeReviewGlobalConfig` type — but forgot to whitelist it here.
 *   Result: the field was silently dropped, the backend always saw the
 *   payload as if the user picked "keep" by default, and rules stayed
 *   ACTIVE after the user explicitly chose Delete.
 *
 *   Importing helpers.ts directly under bare jest pulls in the whole
 *   Next.js / next-auth / api-proxy stack which doesn't transpile
 *   cleanly outside the Next runtime, so this spec validates the
 *   invariant statically by reading the source file.
 *
 *   If anyone removes a key from this list in the future, the test
 *   fails — and the failure message points at the exact field that
 *   would silently disappear in production.
 */
const HELPER_PATH = path.resolve(
    __dirname,
    "../../../apps/web/src/core/utils/helpers.ts",
);

const HELPER_SOURCE = fs.readFileSync(HELPER_PATH, "utf-8");

const REQUIRED_WHITELIST_KEYS = [
    "ideRulesSyncEnabled",
    // The bug from production. Must always be in the whitelist or
    // the toggle-off action never reaches the backend.
    "ideSyncDisableAction",
    "kodyRulesGeneratorEnabled",
    "llmGeneratedMemoriesRequireApproval",
] as const;

describe("codeReviewConfigRemovePropertiesNotInType expectedKeys whitelist", () => {
    for (const key of REQUIRED_WHITELIST_KEYS) {
        it(`includes "${key}" so the field survives the strip`, () => {
            const pattern = new RegExp(`['"]${key}['"]`);
            expect(HELPER_SOURCE).toMatch(pattern);
        });
    }

    it("the function name is unchanged (so the import path stays valid)", () => {
        expect(HELPER_SOURCE).toMatch(
            /export const codeReviewConfigRemovePropertiesNotInType\b/,
        );
    });
});
