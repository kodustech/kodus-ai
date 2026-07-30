import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { RunContext, Scenario } from "../lib/types.js";

// SSO cookie-domain regression as a release-matrix scenario.
//
// Unlike every other scenario in this matrix, SSO does NOT use
// `ctx.kodus` / `ctx.provider`: it has its own droplet topology
// (Caddy + Keycloak + sslip.io) that the regular self-hosted
// installer doesn't ship. We provision that topology on a dedicated
// droplet named "sso-e2e" via the existing standalone scripts —
// they're idempotent (--reuse short-circuits when a droplet already
// exists), so running this scenario in the matrix and then poking
// the droplet manually share the same machine.
//
// Why release-only (not P0): real Let's Encrypt issuance burns the
// sslip.io shared quota and the boot takes ~7 minutes. SSO code is
// rarely touched. The unit suite (31 cases including 5/6-label
// shapes) catches algorithm regressions; this scenario only catches
// the integration-level "Domain attribute actually lands on the
// real Set-Cookie header" regression — worth running on RC promote
// but not on every PR.

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const PROVISION = resolve(
    REPO_ROOT,
    "scripts",
    "sso-e2e",
    "droplet",
    "provision.sh",
);

interface ScriptResult {
    code: number;
    stdout: string;
    stderr: string;
}

function runScript(script: string, args: string[]): Promise<ScriptResult> {
    return new Promise((resolveOk) => {
        const child = spawn("bash", [script, ...args], {
            cwd: REPO_ROOT,
            env: {
                ...process.env,
                // Force headless — the matrix runner has no display.
                // The standalone script defaults to headless too, but
                // we set it explicitly so a stray --headed in someone's
                // shell can't leak in.
                SSO_E2E_HEADLESS: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("close", (code) => {
            resolveOk({ code: code ?? -1, stdout, stderr });
        });
    });
}

export const ssoCookieDomain: Scenario = {
    id: "sso-cookie-domain",
    title:
        "SAML SSO round-trip emits Set-Cookie with the correct Domain attribute on a real droplet",
    priority: "P0",
    appliesTo: {
        // Single cell: self-hosted × github × license-paid. The Domain
        // calculation lives in the API; it's provider-agnostic, so we
        // pick one provider rather than running the SAML round-trip
        // four times against the same code path.
        target: ["self-hosted"],
        provider: ["github"],
        license: ["license-paid"],
    },
    // 8 min for first-time provision (droplet boot + LE issuance + KC
    // start) + 2 min for the Playwright SAML round-trip + slack.
    timeoutSec: 900,
    async run(ctx: RunContext) {
        ctx.assert(
            existsSync(PROVISION),
            `provision script not found at ${PROVISION}`,
        );

        // --reuse: idempotent — if a droplet already exists under the
        // "sso-e2e" name (.kodus-dev/selfhosted-vm-sso-e2e.json), the
        // script just runs the Playwright spec against it. The first
        // cell in a fresh run pays the ~7-min provision tax; any
        // re-run in the same machine completes in ~30s.
        const result = await runScript(PROVISION, [
            "--name",
            "sso-e2e",
            "--reuse",
        ]);

        // Playwright spec prints "[sso-e2e] PASS" or "[sso-e2e] FAIL"
        // as the terminal signal. We grep for those rather than just
        // trusting the exit code because the wrapper script also exits
        // non-zero for unrelated reasons (npm install retry, etc.)
        // that aren't real cookie-domain failures.
        const passLine = result.stdout
            .split("\n")
            .find((l) => l.includes("[sso-e2e] PASS"));
        const failLine = result.stdout
            .split("\n")
            .find((l) => l.includes("[sso-e2e] FAIL"));

        if (failLine || result.code !== 0) {
            // Bubble up enough detail that a release engineer can
            // triage without reading the raw log: which line failed,
            // last 500 chars of stdout (usually the diagnostic dump
            // from the Playwright spec). The full log lives in
            // ctx.artifactDir if anything subscribes there later.
            const tail = result.stdout.slice(-500);
            const errTail = result.stderr.slice(-500);
            ctx.assert(
                false,
                `SSO E2E droplet run failed (exit=${result.code}). ${failLine ?? "(no [sso-e2e] FAIL line)"}\nstdout tail: ${tail}\nstderr tail: ${errTail}`,
            );
        }

        return {
            droplet: "sso-e2e",
            passLine,
            // Pin the cookie Domain we observed — release notes /
            // postmortems can scan this for the actual shape that
            // landed, not just "tests passed".
            cookieDomain: passLine?.match(/Domain=([^,]+)/)?.[1]?.trim(),
            secureFlag: passLine?.includes("Secure=true") ?? false,
            note: "Droplet kept alive for follow-up debugging. Tear down with `pnpm run sso-e2e:droplet:destroy --name sso-e2e`.",
        };
    },
};

export default ssoCookieDomain;
