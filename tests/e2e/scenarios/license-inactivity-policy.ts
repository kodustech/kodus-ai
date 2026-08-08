import { http, ensureOk } from "../lib/http.js";
import type { RunContext, Scenario } from "../lib/types.js";

const AUTO_LICENSE_KEY = "auto_license_assignment";

type AutoAssignConfig = {
    enabled?: boolean;
    ignoredUsers?: string[];
    allowedUsers?: string[];
    inactivityDays?: number | null;
};

// License-inactivity cleanup: the cron that frees idle seats is daily and has
// no manual trigger, so the deactivation decision itself is covered by unit
// tests (DeactivateInactiveLicensesUseCase). What this scenario proves
// end-to-end against a live stack is the user-facing control that drives it:
//   1. POST /organization-parameters/auto-license/inactivity persists the
//      window (30 / 60 / off) onto the AUTO_LICENSE_ASSIGNMENT org param.
//   2. It MERGES — it never clobbers `enabled` / `ignoredUsers` / allowedUsers.
//   3. It validates input (only null | 30 | 60; 45 → 400, config unchanged).
//
// Provider-agnostic (no PR is opened): the policy is org-scoped config, so a
// single provider cell per target is enough.
export const licenseInactivityPolicy: Scenario = {
    id: "license-inactivity-policy",
    title:
        "Auto-license inactivity policy round-trips, merges, and validates the window",
    priority: "P1",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github"],
        license: ["paid", "license-paid"],
    },
    timeoutSec: 180,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, "scenario requires a tenant");
        const baseUrl = ctx.target.apiBaseUrl;

        const session = await ctx.kodus.login(ctx.tenant!);
        const authHeader = { Authorization: `Bearer ${session.accessToken}` };

        const ignoredMarker = `e2e-ignored-${ctx.runId.slice(0, 8)}`;

        const setConfig = async (cfg: AutoAssignConfig) => {
            const resp = await http(`${baseUrl}/organization-parameters/create-or-update`, {
                method: "POST",
                headers: authHeader,
                body: { key: AUTO_LICENSE_KEY, configValue: cfg },
                timeoutMs: 15_000,
            });
            ensureOk(resp, "inactivity:setConfig");
        };

        const setInactivity = async (inactivityDays: number | null) => {
            return http(
                `${baseUrl}/organization-parameters/auto-license/inactivity`,
                {
                    method: "POST",
                    headers: authHeader,
                    body: { inactivityDays },
                    timeoutMs: 15_000,
                },
            );
        };

        const readConfig = async (): Promise<AutoAssignConfig> => {
            const resp = await http<{ data?: { configValue?: AutoAssignConfig } }>(
                `${baseUrl}/organization-parameters/find-by-key?key=${encodeURIComponent(AUTO_LICENSE_KEY)}`,
                {
                    method: "GET",
                    headers: authHeader,
                    timeoutMs: 15_000,
                },
            );
            ensureOk(resp, "inactivity:readConfig");
            // The API wraps payloads in { data: ... }; find-by-key returns
            // { uuid, configKey, configValue, organization }.
            return (
                resp.body?.data?.configValue ??
                (resp.body as any)?.configValue ??
                {}
            );
        };

        try {
            // Seed a known baseline with non-default enabled + ignoredUsers so
            // the merge assertions below are meaningful.
            await setConfig({
                enabled: true,
                ignoredUsers: [ignoredMarker],
                allowedUsers: [],
                inactivityDays: null,
            });

            // 1. Set 30 → readback 30, baseline preserved.
            const r30 = await setInactivity(30);
            ensureOk(r30, "inactivity:set30");
            const after30 = await readConfig();
            ctx.assert(
                after30.inactivityDays === 30,
                `Expected inactivityDays=30, got ${JSON.stringify(after30)}`,
            );
            ctx.assert(
                after30.enabled === true &&
                    Array.isArray(after30.ignoredUsers) &&
                    after30.ignoredUsers.includes(ignoredMarker),
                `Setter clobbered the existing auto-assign config: ${JSON.stringify(after30)}`,
            );

            // 2. Set 60 → readback 60.
            ensureOk(await setInactivity(60), "inactivity:set60");
            const after60 = await readConfig();
            ctx.assert(
                after60.inactivityDays === 60,
                `Expected inactivityDays=60, got ${JSON.stringify(after60)}`,
            );

            // 3. Set off (null) → readback null/absent.
            ensureOk(await setInactivity(null), "inactivity:setOff");
            const afterOff = await readConfig();
            ctx.assert(
                afterOff.inactivityDays == null,
                `Expected inactivityDays cleared, got ${JSON.stringify(afterOff)}`,
            );

            // 4. Invalid window is rejected (400) and leaves config untouched.
            const invalid = await setInactivity(45 as number);
            ctx.assert(
                invalid.status === 400,
                `Expected 400 for inactivityDays=45, got ${invalid.status}: ${invalid.raw.slice(0, 200)}`,
            );
            const afterInvalid = await readConfig();
            ctx.assert(
                afterInvalid.inactivityDays == null,
                `Invalid request must not mutate the policy, got ${JSON.stringify(afterInvalid)}`,
            );

            return {
                target: ctx.target.target,
                license: ctx.license,
                after30,
                after60,
                afterOff,
                invalidStatus: invalid.status,
            };
        } finally {
            // Best-effort: leave the policy disabled so other cells on a
            // shared tenant don't inherit an inactivity window.
            try {
                await setConfig({
                    enabled: false,
                    ignoredUsers: [],
                    allowedUsers: [],
                    inactivityDays: null,
                });
            } catch {
                // recoverable — next run re-seeds the baseline anyway
            }
        }
    },
};

export default licenseInactivityPolicy;
