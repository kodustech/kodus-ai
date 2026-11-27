import { bySignature, evidenceOf, fixRecipe, largerMachine, retry, SELF_HOSTED_MEMORY } from './rule';

// Rules for signatures the cell sets when the repository's build or checkout
// could not become the environment: too slow, too large, refused by the
// sandbox. The repository (or its recipe) is the one to change.

/** A docker memory value as a person reads it: 12288m and 12g are 12 GB. */
const memoryLabel = (limit: string) => {
    const m = /^(\d+)([mg])$/i.exec(limit);
    if (!m) return limit;
    const gb = m[2].toLowerCase() === 'g' ? Number(m[1]) : Number(m[1]) / 1_024;
    return Number.isInteger(gb) ? `${gb} GB` : limit;
};

/**
 * The boot outlived the setup's ceiling: a heavy build (a production image, every
 * service) is the repository's to trim; running it again only waits as long.
 */
export const bootTimeoutRule = bySignature('boot_timeout', ({ input }) => ({
    kind: 'resources',
    signature: 'boot_timeout',
    title: 'The boot takes longer than a setup waits',
    evidence: evidenceOf({ text: input.message }),
    fixes: [
        fixRecipe(
            'Boot only what the PR needs: list the services in services.compose (a compose overlay or profiles), use a development build instead of the production one, and leave out frontends and workers the probes never call. A large compiled image exports faster in two stages, with its compile and module caches in RUN --mount=type=cache instead of a layer.',
        ),
    ],
}));

/**
 * The sandbox killed a build or a service at its memory limit (exit 137): a
 * larger machine size for the environment, or a lighter build.
 */
export const outOfMemoryRule = bySignature('out_of_memory', ({ input }) => {
    const limit = /passed (\S+)/.exec(input.message)?.[1];
    return {
        kind: 'resources',
        signature: 'out_of_memory',
        title: limit ? `The build ran out of memory (${memoryLabel(limit)})` : 'The build ran out of memory',
        evidence: evidenceOf({ text: input.message }),
        fixes: [
            largerMachine(
                `In the environment's Machine size, choose a larger size (Medium 8 GB, Large 16 GB: a heavy compiled build needs it) and run the setup again. ${SELF_HOSTED_MEMORY}`,
            ),
            fixRecipe(
                'Build less at once: a development build instead of the production one, fewer parallel jobs (GOFLAGS=-p=2, NODE_OPTIONS=--max-old-space-size), and the compile caches in RUN --mount=type=cache instead of the image.',
            ),
            {
                ...retry,
                detail: 'Once a larger machine size is saved, run the setup again: it boots at the new size.',
            },
        ],
    };
});

/** The image is larger than a cell keeps for one environment. */
export const imageTooLargeRule = bySignature('image_too_large', ({ input }) => ({
    kind: 'resources',
    signature: 'image_too_large',
    title: 'The image the build produced is larger than a host keeps',
    evidence: evidenceOf({ text: input.message }),
    fixes: [
        fixRecipe(
            'Make the image smaller: a .dockerignore that leaves out node_modules, build output and test data; a two-stage build that copies only what runs; the caches in RUN --mount=type=cache instead of a layer.',
        ),
    ],
}));

/** The cell's sandbox refused the compose project before building anything. */
export const composeRefusedRule = bySignature('compose_refused', ({ input }) => {
    // The memory the services declare (mem_limit, deploy.resources.limits.memory) does not fit the machine size.
    if (/machine size of|share the .* of the environment/.test(input.message)) {
        return {
            kind: 'resources',
            signature: 'compose_refused:memory',
            title: 'The memory the services declare does not fit the environment',
            evidence: evidenceOf({ text: input.message }),
            fixes: [
                largerMachine(
                    `The message names the services and the machine size. In the environment's Machine size, choose a larger size (Medium 8 GB, Large 16 GB) and run the setup again. ${SELF_HOSTED_MEMORY}`,
                ),
                fixRecipe(
                    'Or declare less: lower mem_limit (or deploy.resources.limits.memory) of the services the message names in the compose file the recipe names. Together they must fit the machine size, with room kept for the sandbox.',
                ),
            ],
        };
    }
    return {
        kind: 'toolchain',
        signature: 'compose_refused',
        title: 'The host refused the compose project before building it',
        evidence: evidenceOf({ text: input.message }),
        fixes: [
            fixRecipe(
                'The message names the key the sandbox refuses (privileges, host paths, container names, variables the host would fill in). Remove it from the compose file the recipe names, or name an overlay without it, and run the setup again.',
            ),
        ],
    };
});

/**
 * The cell would not write a build file Kody wrote: the checkout (a pull request's, for a Run)
 * already has that path, or its .kodus is a link. Nothing is followed or replaced (S-05).
 */
export const authoredFilesRule = bySignature('authored_files', ({ input }) => {
    const path = /authored file (\.kodus(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?): /.exec(input.message)?.[1];
    const what = path === '.kodus' ? 'its .kodus is not a plain directory' : path ? `it already has ${path}` : 'it already has a path Kody writes';
    return {
        kind: 'toolchain',
        signature: 'authored_files',
        title: `Kody's build files could not be written: ${what}`,
        evidence: evidenceOf({ text: input.message }),
        fixes: [
            fixRecipe(
                `Kody writes the Dockerfile and compose file of its recipe under .kodus/ of the checkout, never over a file the branch has and never through a link. Remove or rename ${path ?? 'that path'} on this branch, or merge the recipe pull request Kodus opens, which adds the same files to the repository.`,
            ),
        ],
    };
});

/** An entry of the repository the cell refuses to unpack (S-05). */
export const repoRefusedRule = bySignature('repo_refused', ({ input }) => {
    const m = /refused "([^"]+)": ([^\n]+)/.exec(input.message);
    const entry = m?.[1]?.replace(/^[^/]+\//, '') ?? 'an entry';
    return {
        kind: 'toolchain',
        signature: 'repo_refused',
        title: `Kodus refuses to unpack ${entry} from the repository`,
        evidence: { lines: [m ? `${entry}: ${m[2]}` : input.message.slice(0, 300)] },
        fixes: [
            fixRecipe(
                `The host never unpacks a symlink that leaves the repository, a .git entry, a hard link or a device (S-05). Make ${entry} a regular file or a link inside the repository; nothing else in it needs to change.`,
            ),
        ],
    };
});
