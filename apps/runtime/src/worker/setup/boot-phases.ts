import { type Blocked, type Claim, type ClaimProgress, isBlocked } from '@libs/runtime/environment';
import type { BootPhases } from '@libs/runtime/protocol';

/**
 * Where a setup's boot spent its time, for its boot step: the cell's
 * claim.ready timing.phases when it came up; when it did not, the phases of
 * its claim.failed, else the last ones its progress carried (a boot the hub
 * stopped at its ceiling sends no claim.failed). Undefined from a cell that
 * sends none.
 */
export function setupBootPhases(claim: Claim | Blocked, progress: ClaimProgress | null): BootPhases | undefined {
    const phases = isBlocked(claim) ? (claim.blockers.find((b) => b.phases?.length)?.phases ?? progress?.bootPhases) : claim.timing?.phases;
    return phases?.length ? phases : undefined;
}

/**
 * Phases the cell and the platform spend, never the recipe's own build:
 * pulling a base image, moving the build context and the image around,
 * starting the machines and compose. Every other build phase is a step the
 * recipe wrote (a RUN, named by its command, or a COPY/ADD).
 */
const PLATFORM_PHASES: ReadonlySet<string> = new Set([
    'send context', 'import cache', 'export cache', 'export', 'send tarball', 'push layers', 'unpack image',
    'start registry', 'failed try on state', 'docker load', 'pull image', 'compose up', 'compose down', 'first healthy', 'healthy',
    'claim network', 'start machines', 'fetch code', 'upload code', 'boot', 'egress policy', 'observer database',
]);
/** Exporting the layers is as slow as what the recipe put in the image: recipe work only next to an install or a COPY. */
const EXPORT_LAYERS = 'export layers';
const isRecipeStep = (name: string) => !PLATFORM_PHASES.has(name) && name !== EXPORT_LAYERS && !name.startsWith('pull ');
const SLOWEST = 3;

/**
 * The slowest phases of a boot that outlived the setup's ceiling, as evidence
 * lines ("yarn install: 1005.3 s"), when the time went to the recipe's own
 * build: the slowest phase is a RUN or a COPY of the recipe, or the export of
 * the layers with one of those among the slowest. Undefined when no phases
 * were recorded or the platform's took the time (a base image pull, the
 * export alone): restructuring the Dockerfile does not shorten those.
 */
export function recipeBoundTimeout(phases: BootPhases | undefined): string[] | undefined {
    const slowest = [...(phases ?? [])].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST);
    const [first, ...rest] = slowest;
    if (!first) return undefined;
    const recipeBound = isRecipeStep(first.name) || (first.name === EXPORT_LAYERS && rest.some((p) => isRecipeStep(p.name)));
    if (!recipeBound) return undefined;
    return slowest.map((p) => `${p.name}: ${(p.ms / 1_000).toFixed(1)} s${p.running ? ' (still running at the limit)' : ''}`);
}
