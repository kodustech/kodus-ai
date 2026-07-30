import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { RunContext, Scenario } from "../lib/types.js";

// SSO multi-user regression as a release-matrix scenario.
//
// Reuses the same dedicated droplet as sso-cookie-domain (--name
// sso-e2e), idempotent via provision.sh --reuse. The companion
// bootstrap script seeds two extra Keycloak users and flips
// sso_config.active=true so the sign-in / signup paths exercise the
// real production flow.
//
// Restricted to one cell (self-hosted × github × license-paid) — the
// code paths under test (SSO check, SAML callback, status=removed
// rejection) are provider-agnostic, so running 4× per provider is
// pure overhead.

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const RUNNER = resolve(
    REPO_ROOT,
    "scripts",
    "sso-e2e",
    "droplet",
    "run-multi-user.sh",
);

interface ScriptResult {
    code: number;
    stdout: string;
    stderr: string;
}

function runScript(script: string): Promise<ScriptResult> {
    return new Promise((done) => {
        const child = spawn("bash", [script], {
            cwd: REPO_ROOT,
            env: { ...process.env, SSO_E2E_HEADLESS: "1" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => {
            stdout += c.toString();
        });
        child.stderr.on("data", (c) => {
            stderr += c.toString();
        });
        child.on("close", (code) => {
            done({ code: code ?? -1, stdout, stderr });
        });
    });
}

export const ssoMultiUser: Scenario = {
    id: "sso-multi-user",
    title:
        "SSO multi-user flows: admin SSO page, sign-in CTA, new-user signup, removed-user rejection",
    priority: "P0",
    appliesTo: {
        target: ["self-hosted"],
        provider: ["github"],
        license: ["license-paid"],
    },
    // Generous budget: bootstrap-multi-user.sh + 4 sequential Playwright
    // sub-flows each doing a fresh SAML round-trip.
    timeoutSec: 900,
    async run(ctx: RunContext) {
        ctx.assert(existsSync(RUNNER), `runner not found at ${RUNNER}`);

        const result = await runScript(RUNNER);

        // Each sub-flow logs `[sso-multi-user] PASS sub-flow-N: …`.
        // We require all 4 PASS lines AND a zero exit code.
        const passLines = result.stdout
            .split("\n")
            .filter((l) => l.includes("[sso-multi-user] PASS sub-flow-"));
        const failLine = result.stdout
            .split("\n")
            .find((l) => l.includes("[sso-multi-user] FAIL"));

        if (failLine || result.code !== 0 || passLines.length < 4) {
            const tail = result.stdout.slice(-800);
            const errTail = result.stderr.slice(-500);
            ctx.assert(
                false,
                `sso-multi-user failed (exit=${result.code}, passes=${passLines.length}/4). ${failLine ?? "(no FAIL line)"}\nstdout tail: ${tail}\nstderr tail: ${errTail}`,
            );
        }

        return {
            droplet: "sso-e2e",
            subFlowsPassed: passLines.length,
            evidence: passLines.map((l) => l.trim()),
            note: "Droplet kept alive for follow-up debugging. Tear down with `pnpm run sso-e2e:droplet:destroy --name sso-e2e`.",
        };
    },
};

export default ssoMultiUser;
