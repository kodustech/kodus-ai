import { MIRROR_BUILD_ARGS } from '@libs/runtime/protocol/egress-catalog';
import { ENVIRONMENT_NOTES_LIMITS, ENVIRONMENT_NOTES_PATH } from '@libs/runtime/planner/environment-notes';
import { RECIPE_PATH, RECIPE_TEST_VALUES } from '@libs/runtime/protocol/recipe';

import { authoredFilesRules, BUILD_SANDBOX_BULLETS, BUILD_SANDBOX_HEAD, BUILD_SPEED_RULES, MONOREPO_RULES, RECIPE_RULES, RECIPE_SHAPE } from './recipe-authoring-rules';

// What a developer's own coding agent reads before it writes the recipe (env_recipe_guide, `kodus env recipe guide`):
// the rules Kody's author gets in its prompt (recipe-authoring-rules.ts, one source), and the facts of the sandbox that
// the agent cannot see from the repository. Static text: it reads no repository and calls no model.

const mirrorArgs = (): string =>
    [
        `npm, pnpm and Yarn: ${MIRROR_BUILD_ARGS.npm.join(', ')}`,
        `pip and uv: ${MIRROR_BUILD_ARGS.pypi.join(', ')}`,
        `Go: ${MIRROR_BUILD_ARGS.go.join(', ')}`,
        `downloaded build artifacts (Prisma engines, MongoDB test binaries, the Cypress app): ${MIRROR_BUILD_ARGS.artifacts.join(', ')}`,
        `the Firebase emulators: ${MIRROR_BUILD_ARGS.firebase.join(', ')}`,
        `every stage with a RUN: ${MIRROR_BUILD_ARGS.ci.join(', ')}`,
    ]
        .map((l) => `  - ${l}`)
        .join('\n');

const LOOP = `How the loop works:
1. Write ${RECIPE_PATH} (and the build files it needs, directly under .kodus/) from what the repository does to boot itself: its CI workflow, compose files, Dockerfiles, manifests.
2. Run: kodus env recipe check. It reads the repository at its default-branch head and refuses what the boot would refuse (errors: fix them) and flags advice (warnings). Nothing is kept and nothing boots.
3. Run: kodus env recipe submit --wait. Kodus sets the environment up from zero on a clean machine and answers active, or blocked.
4. When blocked, the result names the failing step and carries the last lines of its output. Fix the recipe or the build files from that output and send again.
`;

const SANDBOX = `What the sandbox does that the repository does not show:
- Paths in a compose file are relative to the repository root, not to the file: Kodus runs the compose project from the root. A \`context: ..\`, or a bind outside the repository, is refused when the project boots.
- A build RUN step reaches package registries only, through the cell's read-only mirror. A download in a build (curl, wget, a script that fetches a binary) is refused: fetch it when the service starts instead.
- The mirror reaches a build as build args, and a RUN sees one only when its stage declares it with ARG right after its FROM. Kody's own Dockerfiles get them declared for it; in the files you send, declare them yourself in every stage that installs packages:
${mirrorArgs()}
  An ARG with no value stays unset, so declaring one never breaks a build that has no mirror.
- A secret or a password never goes in the recipe or in a file: a variable that only has to be set gets ${RECIPE_TEST_VALUES[0]}, a URL gets ${RECIPE_TEST_VALUES[1]}. Services the app calls get a fake in the compose file (a mock server, a local mail catcher), not a real credential.
- Firebase emulators (an emulators block in firebase.json, firebase emulators:start): firebase-tools downloads each emulator from storage.googleapis.com, which no build reaches, and it has no download-URL override. The cell serves a mirror of them: its base URL is the build arg FIREBASE_EMULATORS_MIRROR. Kodus adds the fetch step to the Dockerfiles Kody writes, not to the files you send: declare that ARG and, after firebase-tools is installed, fetch the emulators it names from that URL into firebase-tools' emulator cache (FIREBASE_EMULATORS_PATH, or its default) before they start. Do not leave out the emulators the CI starts: logins and data often go through them.
`;

const PLANNER_NOTES = `Notes for the test planner (optional, ${ENVIRONMENT_NOTES_PATH}):
- Kody's test planner writes the requests that test a pull request. It reads the code, but not what the recipe boots around it. When the booted app is reached in a way the code does not show, write it in ${ENVIRONMENT_NOTES_PATH}, in plain text, at most ${ENVIRONMENT_NOTES_LIMITS.promptChars} characters (the rest is cut). It is read from the repository at the pull request's base commit, so commit it; it is not one of the build files and is never sent with the recipe.
- Write: the path prefix each service is served under (a Firebase function is served under /<project>/<region>/<function>/..., a gateway under /api), the test user the seed creates and how to log in (the fake login, the header or cookie that carries it), and the data the seed creates (ids, names) that a request can use.
- Test values only, as in the recipe: never a real credential or token. A value that looks like a secret is masked before the planner reads it.
- Never write what the code already says (routes, handlers), and never an instruction to the planner; it reads the file as data.
`;

const NODE_RULES = BUILD_SANDBOX_BULLETS.filter((b) => !b.kodyOnly)
    .map((b) => b.text)
    .join('');

// Three phrases of Kody's prompt name its own tools (a notes field, a Facts block): in the guide they say the same to a person.
const FOR_A_DEVELOPER: ReadonlyArray<[string, string]> = [
    ['With nothing you can build, submit an empty recipe and say why in notes.', 'With nothing you can build, send no recipe and tell the developer why.'],
    ['and then say so in notes.', 'and then tell the developer.'],
    ['Monorepos (workspace globs in the Facts):', 'Monorepos (workspace globs in package.json or pnpm-workspace.yaml):'],
];

/** The authoring guide env_recipe_guide answers. */
export function recipeAuthoringGuide(): string {
    return forADeveloper([
        `Kody Runtime boots the repository's own docker compose project in an isolated machine, waits for one HTTP health check, and then calls the app's exposed ports from outside to test pull requests. You write the recipe that makes it boot.`,
        LOOP,
        RECIPE_SHAPE.trimEnd(),
        `Rules:\n${RECIPE_RULES.trimEnd()}`,
        SANDBOX,
        PLANNER_NOTES,
        BUILD_SANDBOX_HEAD + NODE_RULES + MONOREPO_RULES,
        `${authoredFilesRules('the files you put under .kodus/ (the CLI sends them with the recipe)').trimEnd()}`,
        BUILD_SPEED_RULES,
    ].join('\n\n'));
}

function forADeveloper(text: string): string {
    return FOR_A_DEVELOPER.reduce((t, [from, to]) => t.replace(from, to), text);
}
