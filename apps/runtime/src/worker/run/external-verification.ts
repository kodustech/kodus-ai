import { ExternalVerificationSchema } from '@libs/runtime/contracts/external-findings';
import { routeShapeOf } from '@libs/runtime/entry-points/coverage';
import type { RuntimeRunRequested } from '@libs/runtime/run/run-messages';

import type { AgentPlan } from '../agent/runtime-agent';

/** External allegations supply a closed plan, never planner instructions or proof. */
export function externalVerificationPlan(req: RuntimeRunRequested): AgentPlan {
    const parsed = ExternalVerificationSchema.safeParse(
        req.externalVerification,
    );
    if (req.trigger !== 'external_finding' || !parsed.success)
        throw new Error('external verification metadata is invalid');
    const probes = parsed.data.findings.map(({ findingId, probe }) => {
        const spec = probe.spec;
        if (spec.kind === 'shell')
            throw new Error(
                'external verification cannot execute internal commands',
            );
        if (spec.kind === 'browser') {
            if (
                !req.environment.expose.some((target) => target.kind === 'http')
            )
                throw new Error(
                    'external browser verification requires an exposed HTTP application',
                );
        } else {
            const exposed = req.environment.expose.some(
                (target) =>
                    target.service === spec.target.service &&
                    target.port === spec.target.port &&
                    (spec.kind === 'http'
                        ? target.kind === 'http'
                        : target.kind === 'postgres' ||
                          target.kind === 'mysql'),
            );
            if (!exposed)
                throw new Error(
                    'external verification target is outside the environment expose',
                );
        }
        return {
            probe: { ...probe, id: findingId, origin: 'external' as const },
            // Only observer request logs can establish actual diff coverage.
            entryPoint:
                spec.kind === 'http'
                    ? `${spec.method} ${routeShapeOf(spec.path)}`
                    : 'unmapped',
        };
    });
    return {
        probes,
        tests: [],
        claims: [],
        rejected: [],
        cannotProve: [],
        explored: 0,
    };
}
