/**
 * Probe, not a CI test: drives the real E2BSandboxService against real E2B
 * and the template in API_E2B_TEMPLATE_ID, with a Git host that only accepts
 * the fixed egress IP (allowlist-git-host.py behind a public tunnel).
 *
 *   python3 scripts/e2b-proxy/allowlist-git-host.py 8099 &
 *   ngrok http 8099
 *   EGRESS_PROBE_URL=https://<tunnel> TS_NODE_TRANSPILE_ONLY=1 \
 *     npx ts-node -r tsconfig-paths/register scripts/e2b-proxy/egress-route-probe.ts
 *
 * Reads API_E2B_KEY and API_E2B_TEMPLATE_ID from the environment, or from
 * the .env at DOTENV_PATH (default ./.env). Each scenario kills its sandbox.
 */
import { createRequire } from 'node:module';
import { isDeepStrictEqual, inspect } from 'node:util';

import { PlatformType } from '@libs/core/domain/enums';
import { E2BSandboxService } from '@libs/sandbox/infrastructure/providers/e2b-sandbox.service';

const requireFromRepo = createRequire(__filename);
requireFromRepo('dotenv').config({
    path: process.env.DOTENV_PATH ?? '.env',
    quiet: true,
});
const { Sandbox } = requireFromRepo('e2b');

const PROBE_URL = process.env.EGRESS_PROBE_URL;
const FIXED_IP = '52.55.217.197';
const ORG = 'probe-org';
const TEAM = 'probe-team';

const results: { name: string; ok: boolean; detail?: unknown }[] = [];
const it = async (name: string, fn: () => Promise<void>) => {
    try {
        await fn();
        results.push({ name, ok: true });
    } catch (error) {
        results.push({
            name,
            ok: false,
            // Always a string, so printing the report cannot fail on it.
            detail: error instanceof Error ? error.message : inspect(error),
        });
    }
};
const expect = (actual: unknown) => ({
    toBe: (expected: unknown) => {
        if (actual !== expected) {
            throw new Error(
                `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
            );
        }
    },
    not: {
        toBe: (expected: unknown) => {
            if (actual === expected) {
                throw new Error(
                    `expected anything but ${JSON.stringify(expected)}`,
                );
            }
        },
    },
    toEqual: (expected: unknown) => {
        if (!isDeepStrictEqual(actual, expected)) {
            throw new Error(
                `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
            );
        }
    },
});

type Decision = { route: 'direct' | 'fixed_ip'; why: string };

const policy = (decision: Decision, fallback: 'allowed' | 'plan') => {
    const marked: unknown[] = [];
    return {
        marked,
        route: async () => decision.route,
        decide: async () => decision,
        fixedIpAllowed: async () => fallback === 'allowed',
        fixedIpFallback: async () => fallback,
        markFixedIpRequired: async (...args: unknown[]) => {
            marked.push(args);
        },
        getFixedIpSetting: async () => {
            throw new Error('unused');
        },
        setFixedIp: async () => {
            throw new Error('unused');
        },
    };
};

const config = {
    get: (key: string) =>
        ({
            API_E2B_KEY: process.env.API_E2B_KEY,
            API_E2B_TEMPLATE_ID: process.env.API_E2B_TEMPLATE_ID,
            API_NODE_ENV: 'development',
        })[key],
};

const serviceWith = (egress: ReturnType<typeof policy>) => {
    const service = new E2BSandboxService(config as any, egress as any);
    const lines: string[] = [];
    const real = (service as any).logger;
    (service as any).logger = new Proxy(real, {
        get: (target, prop) =>
            prop === 'log' || prop === 'warn'
                ? (entry: { message?: string; metadata?: unknown }) => {
                      if (entry?.message?.startsWith('[egress]')) {
                          lines.push(
                              `${String(prop)} ${entry.message} ${JSON.stringify(entry.metadata)}`,
                          );
                      }
                      return target[prop](entry);
                  }
                : target[prop],
    });
    return { service, lines };
};

const egressIp = async (sandboxId: string): Promise<string> => {
    const sbx = await Sandbox.connect(sandboxId, {
        apiKey: process.env.API_E2B_KEY,
    });
    const r = await sbx.commands.run(
        'curl -sf --max-time 15 https://checkip.amazonaws.com',
        { timeoutMs: 30_000 },
    );
    const ip = r.stdout.trim();
    // An empty or garbled answer is no measurement, and must not pass for
    // "not the fixed IP".
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        throw new Error(`could not read the egress IP (got ${inspect(ip)})`);
    }
    return ip;
};

const params = (cloneUrl: string, branch: string) => ({
    cloneUrl,
    authToken: 'probe-token',
    branch,
    platform: PlatformType.GITLAB,
    organizationId: ORG,
    teamId: TEAM,
    sandboxMetadata: { purpose: 'egress-route-probe' },
});

async function main() {
    if (!PROBE_URL) throw new Error('Set EGRESS_PROBE_URL');

    await it('A: direct route leaves from an IP that is not the fixed one', async () => {
        const egress = policy(
            { route: 'direct', why: 'not_marked' },
            'allowed',
        );
        const { service, lines } = serviceWith(egress);
        const instance = await service.createSandboxWithRepo(
            params(`${PROBE_URL}/open.git`, 'feature'),
        );
        const ip = await egressIp(instance.sandboxId);
        console.log('A', { ip, lines, marked: egress.marked });
        await instance.cleanup();
        expect(ip).not.toBe(FIXED_IP);
        expect(lines.some((l) => l.includes('route=direct (not_marked)'))).toBe(
            true,
        );
        expect(egress.marked).toEqual([]);
    });

    await it('B: fixed_ip route leaves from the fixed IP and clones the allowlisted host', async () => {
        const egress = policy({ route: 'fixed_ip', why: 'marked' }, 'allowed');
        const { service, lines } = serviceWith(egress);
        const instance = await service.createSandboxWithRepo(
            params(`${PROBE_URL}/acme.git`, 'feature'),
        );
        const ip = await egressIp(instance.sandboxId);
        console.log('B', { ip, lines });
        await instance.cleanup();
        expect(ip).toBe(FIXED_IP);
        expect(lines.some((l) => l.includes('route=fixed_ip (marked)'))).toBe(
            true,
        );
    });

    await it('C: direct clone refused by the allow list falls back to the fixed IP and marks the organization', async () => {
        const egress = policy(
            { route: 'direct', why: 'not_marked' },
            'allowed',
        );
        const { service, lines } = serviceWith(egress);
        const instance = await service.createSandboxWithRepo(
            params(`${PROBE_URL}/acme.git`, 'feature'),
        );
        const ip = await egressIp(instance.sandboxId);
        console.log('C', { ip, lines, marked: egress.marked });
        await instance.cleanup();
        expect(ip).toBe(FIXED_IP);
        expect(egress.marked).toEqual([
            [{ organizationId: ORG, teamId: TEAM }, 'ip_allow_list'],
        ]);
    });

    await it('D: the same refusal on a plan without the fixed IP fails with the plan reason', async () => {
        const egress = policy({ route: 'direct', why: 'not_in_plan' }, 'plan');
        const { service, lines } = serviceWith(egress);
        const error = await service
            .createSandboxWithRepo(params(`${PROBE_URL}/acme.git`, 'feature'))
            .then(
                () => undefined,
                (e) => e,
            );
        console.log('D', {
            error: error?.name,
            message: error?.message,
            reason: error?.reason,
            blockedBy: error?.blockedBy,
            lines,
        });
        expect(error?.name).toBe('FixedEgressIpUnavailableError');
        expect(error?.reason).toBe('ip_allow_list');
        expect(error?.blockedBy).toBe('plan');
        expect(egress.marked).toEqual([]);
    });
    console.log(JSON.stringify(results, null, 2));
    process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
