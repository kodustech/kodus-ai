import { posix } from 'path';

import { MIRROR_BUILD_ARGS } from '@libs/runtime/protocol/egress-catalog';

import { FIREBASE_EMULATORS_FETCH_SCRIPT } from './firebase-emulators-fetch-script';

// firebase-tools has no download-URL override: its emulators come from storage.googleapis.com, which no machine of
// the cell reaches (docs/runtime/egress-allowlist.md §17). The cell's mirror serves them, so the Dockerfile Kody
// writes for a repository that runs Firebase emulators fetches them from the mirror into firebase-tools' cache, with
// the helper of firebase-emulators-fetch-script.ts, which reads the emulator table of the firebase-tools the
// repository installed: no version is written here.

/** The emulators firebase-tools downloads, in the order the helper fetches them. */
const DOWNLOADABLE = ['database', 'firestore', 'storage', 'pubsub', 'dataconnect'] as const;

const HELPER_PATH = '/tmp/kodus-fetch-firebase-emulators.cjs';
const FROM = /^\s*FROM\s/i;
const CMD = /^\s*(?:CMD|ENTRYPOINT)\s/i;
const NODE_STAGE = /\b(?:node|npm|npx|pnpm|yarn|corepack|firebase)\b|node_modules/i;

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The emulators firebase-tools has to download for the repository at `context`, or null when it runs none: its
 * firebase.json has an `emulators` block naming one firebase-tools downloads, firebase-tools is a dependency (or
 * something Kody wrote installs it), and something starts the emulators (`firebase emulators:start|exec`, in a
 * package.json script or in `evidence`: the recipe and the files Kody writes).
 */
export async function firebaseEmulatorsOf(read: (path: string) => Promise<string | null>, context: string, evidence: string): Promise<string[] | null> {
    const config = await read(posix.normalize(posix.join(context, 'firebase.json')));
    if (config === null) return null;
    let json: unknown;
    try {
        json = JSON.parse(config);
    } catch {
        return null;
    }
    const block = isMap(json) ? json.emulators : undefined;
    if (!isMap(block)) return null;
    const names: string[] = DOWNLOADABLE.filter((n) => n in block);
    // The UI downloads with any emulator it can show, unless firebase.json turns it off.
    const ui = block.ui;
    if (names.length && !(isMap(ui) && ui.enabled === false)) names.push('ui');
    if (!names.length) return null;

    const manifest = (await read(posix.normalize(posix.join(context, 'package.json')))) ?? '';
    let pkg: unknown;
    try {
        pkg = JSON.parse(manifest);
    } catch {
        pkg = undefined;
    }
    const dependsOn = isMap(pkg) && ['dependencies', 'devDependencies', 'optionalDependencies'].some((k) => isMap(pkg[k]) && 'firebase-tools' in (pkg[k] as object));
    if (!dependsOn && !/firebase-tools/.test(evidence)) return null;
    if (!/emulators:(?:start|exec)\b/.test(`${manifest}\n${evidence}`)) return null;
    return names;
}

/**
 * The Dockerfile with the Firebase emulators fetched from the cell mirror in its last stage, and what was added: the
 * mirror's ARG after its FROM and the fetch before its CMD, where firebase-tools (a dependency the stage installed or
 * copied, or one installed globally) is in place. A last stage with no Node tooling, and a Dockerfile that already
 * has the step, stay as they are.
 */
export function addFirebaseEmulatorFetch(path: string, content: string, emulators: readonly string[]): { content: string; changes: string[] } {
    const unchanged = { content, changes: [] };
    if (!emulators.length || content.includes(HELPER_PATH)) return unchanged;
    const lines = content.split('\n');
    const from = lines.map((l, i) => (FROM.test(l) ? i : -1)).filter((i) => i >= 0).at(-1);
    if (from === undefined || !NODE_STAGE.test(lines.slice(from).join('\n'))) return unchanged;
    let afterFrom = from;
    while (/\\\s*$/.test(lines[afterFrom]) && afterFrom + 1 < lines.length) afterFrom++;
    let at = lines.findIndex((l, i) => i > afterFrom && CMD.test(l));
    if (at < 0) {
        at = lines.length;
        while (at > afterFrom + 1 && lines[at - 1].trim() === '') at--;
    }
    const arg = MIRROR_BUILD_ARGS.firebase[0];
    const encoded = Buffer.from(FIREBASE_EMULATORS_FETCH_SCRIPT, 'utf8').toString('base64');
    const run = `RUN echo ${encoded} | base64 -d > ${HELPER_PATH} && node ${HELPER_PATH} ${emulators.join(' ')} && rm ${HELPER_PATH}`;
    const out = [...lines.slice(0, afterFrom + 1), `ARG ${arg}`, ...lines.slice(afterFrom + 1, at), run, ...lines.slice(at)];
    return {
        content: out.join('\n'),
        changes: [
            `${path}: fetches the Firebase emulators: ${emulators.join(', ')} from the cell's read-only mirror into firebase-tools' cache (it has no download-URL override, and the emulators' own host is closed to a build); the names, versions and checksums come from the firebase-tools the repository installs`,
        ],
    };
}
