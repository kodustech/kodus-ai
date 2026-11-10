import { describeMachineSize, fitsWithin } from '@libs/runtime/contracts/machine-size';
import type { Blocked } from '@libs/runtime/environment';
import { type CellFeature, knownCellFeatures, type MachineSize, type MessageBody, requiredRecipeFeatures } from '@libs/runtime/protocol';

// What a cell said in its hello it may be asked (protocol CELL_FEATURES):
// which optional claim.acquire fields it decodes, and the largest size it
// grants one claim. The hub keeps them with the cell's session and sends a
// cell nothing else, so a newer hub never breaks an older cell's strict
// decoder, and a sized claim never reaches a cell that would run it at its
// default size or refuse it.

export interface CellCapabilities {
    features: readonly CellFeature[];
    /**
     * The largest size the cell grants one claim; null when it grants none.
     * Only ever set with the claimSize feature: a cell that does not decode
     * size grants no size, whatever it says its driver could (the cell
     * directory's routing relies on this, shared/cell-directory.ts).
     */
    maxClaimSize: MachineSize | null;
}

/** A cell older than the negotiation: its hello names nothing. */
export const NO_CAPABILITIES: CellCapabilities = { features: [], maxClaimSize: null };

export function capabilitiesOfHello(hello: MessageBody<'hello'>): CellCapabilities {
    const features = knownCellFeatures(hello.features);
    const maxClaimSize = features.includes('claimSize') && hello.maxClaimSize ? { memoryMb: hello.maxClaimSize.memoryMb, cpus: hello.maxClaimSize.cpus } : null;
    return { features, maxClaimSize };
}

/** Whether the cell decodes the claim.acquire field of `feature`; a session that names no features supports none. */
export const supports = (caps: Partial<CellCapabilities>, feature: CellFeature): boolean => !!caps.features?.includes(feature);

/**
 * The blocker of a recipe that needs the files Kody wrote, for a cell that
 * cannot write them (its hello names no authoredFiles). Booted without them,
 * the recipe would name a Dockerfile or compose file the checkout does not
 * have, so nothing is sent and nothing boots.
 */
export function authoredFilesUnsupported(): Blocked {
    return {
        status: 'blocked',
        blockers: [
            {
                kind: 'platform',
                signature: AUTHORED_FILES_UNSUPPORTED,
                message: "this cell's build is older than the build files Kody writes with its recipe (its hello names no authoredFiles); the claim was not started",
            },
        ],
    };
}

/** The signature of authoredFilesUnsupported (the blocker catalog's card). */
export const AUTHORED_FILES_UNSUPPORTED = 'authored_files_unsupported';

/** Whether the cell grants `size` to one claim. */
export const grantsSize = (caps: Partial<CellCapabilities>, size: MachineSize): boolean =>
    supports(caps, 'claimSize') && !!caps.maxClaimSize && fitsWithin(size, caps.maxClaimSize);

/**
 * The blocker of a size the cell does not grant, worded as the cell words
 * its own refusal (resources/size_unavailable). Nothing was sent to the
 * cell and nothing booted, so the blocked result names no cell.
 */
export function sizeUnavailable(caps: Partial<CellCapabilities>, size: MachineSize): Blocked {
    const max = supports(caps, 'claimSize') ? caps.maxClaimSize : null;
    const grants = max ? `this cell grants at most ${describeMachineSize(max)}` : 'this cell grants no machine size';
    return {
        status: 'blocked',
        blockers: [{ kind: 'resources', signature: 'size_unavailable', message: `asked ${describeMachineSize(size)}, ${grants}` }],
    };
}

/** Recipe fields require execution support, not merely an accepting YAML parser. */
export function recipeCapabilityBlocker(caps: Partial<CellCapabilities>, recipe: { content?: string | null } | undefined): Blocked | undefined {
    const requirements = requiredRecipeFeatures(recipe);
    if (requirements.ok === false) return {
        status: 'blocked',
        blockers: [{ kind: 'recipe_outdated', signature: 'recipe_invalid', message: 'the trusted base recipe is invalid; correct the recipe before requesting this claim' }],
    };
    const missing = requirements.features.filter((feature) => !supports(caps, feature));
    if (missing.length) return {
        status: 'blocked',
        blockers: [{ kind: 'platform', signature: 'recipe_capability_unsupported', message: `this cell does not advertise required recipe execution support: ${missing.join(', ')}; upgrade or select a capable cell; the claim was not started` }],
    };
    return undefined;
}
