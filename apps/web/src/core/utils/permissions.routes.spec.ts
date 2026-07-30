import { UserRole } from "@enums";

import { canAccessRoute } from "./permissions.routes";

// Matrix mirror of the backend authorization-matrix.spec.ts, but for the
// FRONTEND middleware route guard (canAccessRoute). The backend matrix proved
// the API allows repo_admin on TokenUsage; this proves the middleware actually
// lets repo_admin reach the /token-usage page instead of bouncing to
// /forbidden — the exact regression from issue #1229.

const access = (role: UserRole, pathname: string) =>
    canAccessRoute({ role, pathname });

describe("canAccessRoute", () => {
    it("owner reaches everything (including unmapped paths)", () => {
        expect(access(UserRole.OWNER, "/token-usage")).toBe(true);
        expect(access(UserRole.OWNER, "/anything/not/mapped")).toBe(true);
    });

    describe("Token Usage (#1229 regression)", () => {
        it("repo_admin can reach /token-usage", () => {
            expect(access(UserRole.REPO_ADMIN, "/token-usage")).toBe(true);
        });
        it("billing_manager can reach /token-usage", () => {
            expect(access(UserRole.BILLING_MANAGER, "/token-usage")).toBe(true);
        });
        it("contributor cannot reach /token-usage", () => {
            expect(access(UserRole.CONTRIBUTOR, "/token-usage")).toBe(false);
        });
    });

    describe("previously-orphaned routes are now reachable", () => {
        it("every non-owner role reaches /helpdesk (support)", () => {
            for (const role of [
                UserRole.REPO_ADMIN,
                UserRole.BILLING_MANAGER,
                UserRole.CONTRIBUTOR,
            ]) {
                expect(access(role, "/helpdesk")).toBe(true);
            }
        });
        it("every non-owner role reaches /cli/authorize", () => {
            for (const role of [
                UserRole.REPO_ADMIN,
                UserRole.BILLING_MANAGER,
                UserRole.CONTRIBUTOR,
            ]) {
                expect(access(role, "/cli/authorize")).toBe(true);
            }
        });
        it("git settings covers /settings/integrations", () => {
            // repo_admin has GitSettings read in ROLE_POLICIES
            expect(
                access(UserRole.REPO_ADMIN, "/settings/integrations"),
            ).toBe(true);
        });
    });

    describe("denies what the role has no policy for", () => {
        it("contributor cannot reach /cockpit", () => {
            expect(access(UserRole.CONTRIBUTOR, "/cockpit")).toBe(false);
        });
        it("contributor cannot reach /settings/subscription (Billing)", () => {
            expect(
                access(UserRole.CONTRIBUTOR, "/settings/subscription"),
            ).toBe(false);
        });
    });

    describe("contributor read-only visibility (everything but cockpit/token-usage)", () => {
        it("contributor can reach /settings/git", () => {
            expect(access(UserRole.CONTRIBUTOR, "/settings/git")).toBe(true);
        });
        it("contributor can reach /pull-requests", () => {
            expect(access(UserRole.CONTRIBUTOR, "/pull-requests")).toBe(true);
        });
    });

    describe("prefix-collision must not bypass authorization", () => {
        // `/cli/*` is public (All base routes); `/cli-reviews/*` is CliReview.
        // A naive startsWith would grant `/cli-reviews` to anyone via `/cli`.
        // billing_manager has NO CliReview grant, so it must be denied.
        it("billing_manager (no CliReview) cannot reach /cli-reviews via the /cli prefix", () => {
            expect(access(UserRole.BILLING_MANAGER, "/cli-reviews")).toBe(false);
        });
        it("the public /cli/* still grants the actual /cli sub-path", () => {
            expect(access(UserRole.BILLING_MANAGER, "/cli/authorize")).toBe(true);
        });
    });
});
