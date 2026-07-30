import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RunContext, Scenario } from "../lib/types.js";

// Stripe billing lifecycle as a cloud release-matrix scenario.
//
// Drives 4 sub-flows against QA cloud (qa.web.kodus.io):
//   1. free  → paid   via Stripe Checkout
//   2. trial → paid   via Stripe Checkout
//   3. paid  → cancel via Stripe Customer Portal
//   4. paid  → free   via /api/proxy/billing/migrate-to-free
//
// Uses 2 dedicated tenants seeded by cli/cloud/setup-tenants.ts. Each
// run mutates billing state on the QA tenant (subscription transitions
// to active, then cancelled, then back to free). The Playwright spec
// is robust to whatever state the previous run left behind because
// every sub-flow either starts a fresh Checkout (idempotent) or hits
// migrate-to-free (idempotent on already-free).
//
// Restricted to a single cloud × github × paid cell. The endpoints are
// provider-agnostic — testing 4× per provider would be pure overhead.

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const SPEC = resolve(REPO_ROOT, "tests", "e2e", "playwright", "stripe-billing.mjs");
const PLAYWRIGHT_DIR = resolve(REPO_ROOT, "tests", "e2e", "playwright");

interface CloudTenantEntry {
    email: string;
    password: string;
    license?: string;
}

function findTenantPassword(): string | undefined {
    const path = join(homedir(), ".kodus-dev", "cloud-tenants.json");
    if (!existsSync(path)) return undefined;
    try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as CloudTenantEntry[];
        const t = parsed.find(
            (e) => e.email === "e2e-stripe-checkout-free@kodus.io",
        );
        return t?.password;
    } catch {
        return undefined;
    }
}

interface SpecResult {
    code: number;
    stdout: string;
    stderr: string;
}

function runSpec(env: Record<string, string>): Promise<SpecResult> {
    return new Promise((done) => {
        const child = spawn("node", ["stripe-billing.mjs"], {
            cwd: PLAYWRIGHT_DIR,
            env: { ...process.env, ...env },
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

export const stripeBilling: Scenario = {
    id: "stripe-billing",
    title:
        "Stripe billing lifecycle: free/trial → paid via Checkout, paid → cancel via Portal, paid → free via migrate-to-free",
    priority: "P0",
    appliesTo: {
        // Cloud-only: the billing service only exists in the SaaS
        // control plane. Single cell because the endpoints are
        // provider-agnostic.
        target: ["cloud"],
        provider: ["github"],
        license: ["paid"],
    },
    // 4 × (login + Checkout/Portal navigation + webhook poll ≤60s) +
    // ~30s of buffer for QA cold-start and Stripe page load.
    timeoutSec: 600,
    async run(ctx: RunContext) {
        ctx.assert(existsSync(SPEC), `Playwright spec not found at ${SPEC}`);

        const password =
            process.env.STRIPE_E2E_PASSWORD ?? findTenantPassword();
        ctx.assert(
            !!password,
            "STRIPE_E2E_PASSWORD env not set and no e2e-stripe-checkout-free entry in ~/.kodus-dev/cloud-tenants.json — run `pnpm run cloud:setup-tenants` first",
        );

        const result = await runSpec({
            STRIPE_E2E_WEB_URL:
                process.env.STRIPE_E2E_WEB_URL ?? ctx.target.webBaseUrl,
            STRIPE_E2E_FREE_EMAIL:
                process.env.STRIPE_E2E_FREE_EMAIL ??
                "e2e-stripe-checkout-free@kodus.io",
            STRIPE_E2E_TRIAL_EMAIL:
                process.env.STRIPE_E2E_TRIAL_EMAIL ??
                "e2e-stripe-checkout-trial@kodus.io",
            STRIPE_E2E_PASSWORD: password!,
            STRIPE_E2E_HEADLESS: process.env.STRIPE_E2E_HEADLESS ?? "1",
        });

        const passLines = result.stdout
            .split("\n")
            .filter((l) => l.includes("[stripe-billing] PASS sub-flow-"));
        const failLine = result.stdout
            .split("\n")
            .find((l) => l.includes("[stripe-billing] FAIL"));

        if (failLine || result.code !== 0 || passLines.length < 4) {
            const tail = result.stdout.slice(-1200);
            const errTail = result.stderr.slice(-500);
            ctx.assert(
                false,
                `stripe-billing failed (exit=${result.code}, passes=${passLines.length}/4). ${failLine ?? "(no FAIL line)"}\nstdout tail: ${tail}\nstderr tail: ${errTail}`,
            );
        }

        return {
            subFlowsPassed: passLines.length,
            evidence: passLines.map((l) => l.trim()),
            note:
                "Tenants e2e-stripe-checkout-{free,trial}@kodus.io were mutated. Idempotent — re-runs will re-exercise the same lifecycle.",
        };
    },
};

export default stripeBilling;
