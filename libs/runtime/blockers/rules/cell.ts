import { bySignature, evidenceOf, largerMachine, retry, SELF_HOSTED_MEMORY, useOwnCell } from './rule';

// Rules for signatures the hub or the cell sets when it could not place or
// run the boot: no cell, no room, no backend, a builder or an image the cell
// lost. Nothing in the repository is the cause, except a machine size no
// cell grants.

/**
 * The cell that took the Run holds no prepared image of the environment (a new or
 * reinstalled cell, or a setup that ran on another one): nothing in the repository to change.
 */
export const environmentNotPreparedRule = bySignature('environment_not_prepared', ({ input }) => ({
    kind: 'platform',
    signature: 'environment_not_prepared',
    title: 'The cell that ran this has no prepared image of the environment',
    evidence: evidenceOf({ text: input.message }),
    fixes: [
        {
            ...retry,
            detail: 'Your repository is not the cause. The environment was set up on another cell, or before this one was replaced. Run the setup again; pull requests run once it is active.',
        },
    ],
}));

/**
 * The cell's disk floor evicted the environment's build state and no setup made it again: the
 * PR would build cold, past its wait, so nothing booted (claim.service.ts buildStateEvictedBlocker).
 */
export const buildStateEvictedRule = bySignature('build_state_evicted', ({ input }) => ({
    kind: 'platform',
    signature: 'build_state_evicted',
    title: "The cell removed this environment's build cache to free disk",
    evidence: evidenceOf({ text: input.message }),
    fixes: [
        {
            ...retry,
            detail: 'Your repository is not the cause. Without its build cache the pull request would build from nothing, past the time a boot waits, so it was not started. Run the setup again; pull requests build warm once it is active.',
        },
    ],
}));

/** No cell took the boot: nothing ran, nothing in the repository to change. */
export const cellUnavailableRule = bySignature('cell_unavailable', ({ input }) => ({
    kind: 'platform',
    signature: 'cell_unavailable',
    title: 'No cell was connected to boot this environment',
    evidence: evidenceOf({ text: input.message }),
    fixes: [
        {
            ...retry,
            detail: 'Nothing booted and your repository is not the cause. On your own cell, check that it runs and shows as connected under Cells; then run the setup again.',
        },
    ],
}));

/**
 * Cells were connected but none could take the claim: nothing was sent to a cell,
 * nothing in the repository to change. Waiting frees a slot; an own cell is not shared.
 */
export const orgCapacityRule = bySignature('org_capacity', ({ input }) => {
    const cap = /\(cap (\d+)\)/.exec(input.message)?.[1];
    return {
        kind: 'resources',
        signature: 'org_capacity',
        title: cap
            ? `Your organization is using all ${cap} machines it may hold on shared Kodus cells`
            : 'Your organization is using all the machines it may hold on shared Kodus cells',
        evidence: evidenceOf({ text: input.message }),
        fixes: [
            {
                ...retry,
                label: 'Wait, then run it again',
                detail: 'Nothing booted and your repository is not the cause. Your other runs and setups free their machines when they finish; run this one again then.',
            },
            useOwnCell,
        ],
    };
});

/**
 * The org's machine minutes of the UTC day are spent (hub, machine-minutes.ts): nothing was sent
 * to a cell and nothing in the repository to change; running it again before the reset is refused the same.
 */
export const machineMinutesExhaustedRule = bySignature('machine_minutes_exhausted', ({ input }) => ({
    kind: 'resources',
    signature: 'machine_minutes_exhausted',
    title: "Your organization used all of today's machine minutes",
    evidence: evidenceOf({ text: input.message }),
    fixes: [
        {
            ...retry,
            label: 'Wait for the reset, then run it again',
            detail: 'Nothing booted and your repository is not the cause. New setups and Runs wait until the machine minutes reset at 00:00 UTC; run this one again then.',
        },
    ],
}));

export const noCapacityRule = bySignature('no_capacity', ({ input }) => ({
    kind: 'resources',
    signature: 'no_capacity',
    title: 'Every cell that can run this environment is full',
    evidence: evidenceOf({ text: input.message }),
    fixes: [
        {
            ...retry,
            label: 'Wait, then run it again',
            detail: 'Nothing booted and your repository is not the cause. Machines free up as other runs finish; run this one again in a few minutes.',
        },
        useOwnCell,
    ],
}));

/**
 * The builder died under the build: no build step failed and BuildKit wrote no
 * error, or docker could not start the builder (exit 125-127). The cell's fault,
 * not the recipe's: running it again is the fix, and the repository is not changed.
 */
export const builderFailedRule = bySignature('builder_failed', ({ input }) => ({
    kind: 'platform',
    signature: 'builder_failed',
    title: 'The image builder stopped before the build finished',
    evidence: evidenceOf({ text: input.message }),
    fixes: [
        {
            ...retry,
            detail: 'No build step failed and your repository is not the cause: the builder on the cell stopped. Run the setup again.',
        },
    ],
}));

/**
 * The image the build produced could not be loaded, or did not name only the
 * image that was asked for: the cell refuses it and nothing boots from it.
 */
export const imageLoadRule = bySignature('image_load', ({ input }) => ({
    kind: 'platform',
    signature: 'image_load',
    title: 'The cell could not load the image the build produced',
    evidence: evidenceOf({ text: input.message }),
    fixes: [
        {
            ...retry,
            detail: 'The build finished, but its image was refused or could not be loaded on the cell. Run the setup again; if it repeats, the build output is malformed and the recipe needs a look.',
        },
    ],
}));

/**
 * The environment asked a machine size above the largest a cell grants:
 * the cell refused it, or no connected cell grants it and the claim went
 * to none (the worker's routing). Nothing was created either way; the
 * evidence names what was asked and the most a cell grants. A smaller
 * size, or a cell that grants it.
 */
export const sizeUnavailableRule = bySignature('size_unavailable', ({ input }) => ({
    kind: 'resources',
    signature: 'size_unavailable',
    title: 'No cell grants this machine size',
    evidence: evidenceOf({ text: input.message }),
    fixes: [
        {
            ...largerMachine(
                `In the environment's Machine size, choose a size within what the cell grants and run the setup again. ${SELF_HOSTED_MEMORY} A cell of a build older than machine sizes grants none until it is updated.`,
            ),
            label: 'Choose a machine size a cell grants',
        },
        useOwnCell,
    ],
}));

/**
 * The claim asks an isolation (a microVM) no connected cell gives: nothing was sent and
 * nothing booted. It is never run on a lower isolation; a cell that gives it has to connect.
 */
export const isolationUnavailableRule = bySignature('isolation_unavailable', ({ input }) => ({
    kind: 'capacity',
    signature: 'isolation_unavailable',
    title: 'No cell gives the isolation this environment asks for',
    evidence: evidenceOf({ text: input.message }),
    fixes: [
        {
            ...useOwnCell,
            label: 'Run it on a cell that gives that isolation',
            detail: 'Nothing booted and your repository is not the cause. A claim that asks for a virtual machine runs only on a cell with a microVM backend (a host with KVM), never on a lower isolation. Register such a cell under Cells, or run the setup again once one is connected.',
        },
    ],
}));

/**
 * The Run's other side ran on a backend (driver, isolation) no connected cell runs now: nothing
 * was sent. Run on another backend, the two sides would differ by kernel and build path, not by the PR.
 */
export const backendUnavailableRule = bySignature('backend_unavailable', ({ input }) => ({
    kind: 'capacity',
    signature: 'backend_unavailable',
    title: 'No cell runs the backend the other side of this Run ran on',
    evidence: evidenceOf({ text: input.message }),
    fixes: [
        {
            ...retry,
            detail: 'Nothing booted and your repository is not the cause. Both sides of a Run boot on one backend so a difference between them comes from the pull request, not from the machine. Run it again: a new Run places both sides on the cells connected now.',
        },
    ],
}));

/**
 * Kody's recipe needs the build files it wrote, and the cell's build cannot write them:
 * nothing was sent. Booted without them, it would name files the checkout lacks.
 */
export const authoredFilesUnsupportedRule = bySignature('authored_files_unsupported', ({ input }) => ({
    kind: 'platform',
    signature: 'authored_files_unsupported',
    title: 'This cell is too old for the build files Kody wrote',
    evidence: evidenceOf({ text: input.message }),
    fixes: [
        {
            ...retry,
            label: 'Update the cell, then run it again',
            detail: "Nothing booted and your repository is not the cause. Kody's recipe builds from a Dockerfile or compose file it wrote under .kodus/, which only a newer cell writes into the checkout. On your own cell, update it to the current build; on Kodus cells, run the setup again once they are updated.",
        },
    ],
}));
