import { MIRROR_BUILD_ARGS } from '@libs/runtime/protocol/egress-catalog';

import { addFirebaseEmulatorFetch, firebaseEmulatorsOf } from './authored-dockerfile-firebase';
import { checkAuthoredSubmission } from './authored-files-policy';
import { FIREBASE_EMULATORS_FETCH_SCRIPT } from './firebase-emulators-fetch-script';

// firebase-tools has no download-URL override, so a repository that runs Firebase emulators needs them fetched from
// the cell's mirror into firebase-tools' cache (docs/runtime/egress-allowlist.md §17). Kody does it in the
// Dockerfile it writes, from the emulator table of the firebase-tools the repository installed.

const reader = (files: Record<string, string>) => async (p: string) => files[p] ?? null;
const FIREBASE_JSON = JSON.stringify({ emulators: { auth: { port: 9099 }, firestore: { port: 8080 }, storage: { port: 9199 }, ui: { enabled: true }, singleProjectMode: true } });
const PACKAGE = JSON.stringify({ scripts: { 'test:rules': 'firebase emulators:exec --only firestore "jest"' }, devDependencies: { 'firebase-tools': '14.27.0' } });
const REPO = { 'firebase.json': FIREBASE_JSON, 'package.json': PACKAGE, 'package-lock.json': '{}' };

describe('which Firebase emulators a repository runs', () => {
    it('names the downloadable emulators of firebase.json, in a fixed order, with the UI on unless it is turned off', async () => {
        expect(await firebaseEmulatorsOf(reader(REPO), '.', '')).toEqual(['firestore', 'storage', 'ui']);
        const off = { ...REPO, 'firebase.json': JSON.stringify({ emulators: { database: {}, pubsub: {}, ui: { enabled: false } } }) };
        expect(await firebaseEmulatorsOf(reader(off), '.', '')).toEqual(['database', 'pubsub']);
        const dataconnect = { ...REPO, 'firebase.json': JSON.stringify({ emulators: { dataconnect: { port: 9399 } } }) };
        expect(await firebaseEmulatorsOf(reader(dataconnect), '.', '')).toEqual(['dataconnect', 'ui']);
    });

    it('reads firebase.json in the build context', async () => {
        const nested = Object.fromEntries(Object.entries(REPO).map(([k, v]) => [`web/${k}`, v]));
        expect(await firebaseEmulatorsOf(reader(nested), 'web', '')).toEqual(['firestore', 'storage', 'ui']);
        expect(await firebaseEmulatorsOf(reader(nested), '.', '')).toBeNull();
    });

    it('is null without an emulators block, with only emulators firebase-tools does not download, or with a firebase.json that is not JSON', async () => {
        expect(await firebaseEmulatorsOf(reader({ ...REPO, 'firebase.json': '{"hosting":{"public":"dist"}}' }), '.', '')).toBeNull();
        expect(await firebaseEmulatorsOf(reader({ ...REPO, 'firebase.json': '{"emulators":{"auth":{},"functions":{}}}' }), '.', '')).toBeNull();
        expect(await firebaseEmulatorsOf(reader({ ...REPO, 'firebase.json': '{ // comment\n}' }), '.', '')).toBeNull();
        expect(await firebaseEmulatorsOf(reader({ 'package.json': PACKAGE }), '.', '')).toBeNull();
    });

    it('needs firebase-tools in the repository and something that starts the emulators', async () => {
        const noTools = { ...REPO, 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) };
        expect(await firebaseEmulatorsOf(reader(noTools), '.', 'CMD firebase emulators:start')).toBeNull();
        expect(await firebaseEmulatorsOf(reader(noTools), '.', 'RUN npm i -g firebase-tools')).toBeNull();
        expect(await firebaseEmulatorsOf(reader(noTools), '.', 'RUN npm i -g firebase-tools\nCMD firebase emulators:start')).toEqual(['firestore', 'storage', 'ui']);
        const noStart = { ...REPO, 'package.json': JSON.stringify({ devDependencies: { 'firebase-tools': '14.27.0' }, scripts: { build: 'tsc' } }) };
        expect(await firebaseEmulatorsOf(reader(noStart), '.', 'the recipe')).toBeNull();
        expect(await firebaseEmulatorsOf(reader(noStart), '.', 'command: firebase emulators:start --only firestore')).toEqual(['firestore', 'storage', 'ui']);
    });
});

const NODE_DOCKERFILE = 'FROM node:22-bookworm\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci\nCOPY . .\nEXPOSE 8080\nCMD ["npx", "firebase", "emulators:start"]\n';
const decoded = (dockerfile: string) => {
    const line = dockerfile.split('\n').find((l) => l.startsWith('RUN ') && l.includes('base64 -d'))!;
    return Buffer.from(/echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(line)![1], 'base64').toString('utf8');
};

describe('the Firebase emulators step of an authored Dockerfile', () => {
    it('declares the mirror arg in the final stage and fetches the emulators before the command starts', () => {
        const out = addFirebaseEmulatorFetch('.kodus/Dockerfile', NODE_DOCKERFILE, ['firestore', 'ui']);
        const lines = out.content.split('\n');
        expect(lines[1]).toBe(`ARG ${MIRROR_BUILD_ARGS.firebase[0]}`);
        const run = lines.findIndex((l) => l.startsWith('RUN ') && l.includes('base64 -d'));
        expect(run).toBe(lines.findIndex((l) => l.startsWith('CMD')) - 1);
        expect(lines[run]).toMatch(/&& node \/tmp\/kodus-fetch-firebase-emulators\.cjs firestore ui && rm /);
        expect(decoded(out.content)).toBe(FIREBASE_EMULATORS_FETCH_SCRIPT);
        expect(out.changes).toEqual([expect.stringContaining('Firebase emulators: firestore, ui')]);
    });

    it('goes only in the last stage, after the install, and only once', () => {
        const staged = 'FROM node:22 AS deps\nRUN npm ci\nFROM node:22\nCOPY --from=deps /app/node_modules ./node_modules\nCMD ["npm", "test"]\n';
        const out = addFirebaseEmulatorFetch('.kodus/Dockerfile', staged, ['database']);
        expect(out.content.match(/base64 -d/g)).toHaveLength(1);
        expect(out.content.indexOf('base64 -d')).toBeGreaterThan(out.content.indexOf('FROM node:22\nARG'));
        expect(addFirebaseEmulatorFetch('.kodus/Dockerfile', out.content, ['database'])).toEqual({ content: out.content, changes: [] });
    });

    it('with no CMD it goes at the end, and a final stage with no Node tooling gets nothing', () => {
        const noCmd = addFirebaseEmulatorFetch('.kodus/Dockerfile', 'FROM node:22\nRUN npm ci\n', ['storage']);
        expect(noCmd.content.trimEnd().split('\n').at(-1)).toContain('base64 -d');
        const nginx = 'FROM nginx:1.27\nCOPY dist /usr/share/nginx/html\n';
        expect(addFirebaseEmulatorFetch('.kodus/Dockerfile', nginx, ['storage'])).toEqual({ content: nginx, changes: [] });
    });
});

describe('a submission for a repository that runs Firebase emulators', () => {
    const COMPOSE = 'services:\n  app:\n    build: { context: ., dockerfile: .kodus/Dockerfile }\n';
    const RECIPE = 'version: 1\nservices:\n  compose:\n    files: [.kodus/compose.yaml]\n    public: app\n    health: /\n  expose:\n    - { service: app, port: 8080, kind: http }\n';
    const submit = (repo: Record<string, string>, dockerfile = NODE_DOCKERFILE) =>
        checkAuthoredSubmission(RECIPE, [{ path: '.kodus/Dockerfile', content: dockerfile }, { path: '.kodus/compose.yaml', content: COMPOSE }], async (p) => p in repo, reader(repo));
    const dockerfileOf = (r: Awaited<ReturnType<typeof submit>>) => r.files!.find((f) => f.path === '.kodus/Dockerfile')!.content;

    it('gets the fetch step and its ARG in its Dockerfile, and the emulators come from firebase.json', async () => {
        const r = await submit(REPO);
        expect(r.errors).toEqual([]);
        const dockerfile = dockerfileOf(r);
        expect(dockerfile).toContain('ARG FIREBASE_EMULATORS_MIRROR');
        expect(dockerfile).toContain('node /tmp/kodus-fetch-firebase-emulators.cjs firestore storage ui');
        expect(r.adjusted?.join('\n')).toContain('Firebase emulators: firestore, storage, ui');
    });

    it('gets nothing of it without Firebase emulators in the repository', async () => {
        const r = await submit({ 'package.json': JSON.stringify({ name: 'app' }), 'package-lock.json': '{}' }, NODE_DOCKERFILE.replace('"npx", "firebase", "emulators:start"', '"npm", "start"'));
        expect(r.errors).toEqual([]);
        expect(dockerfileOf(r)).not.toMatch(/firebase|FIREBASE/i);
    });
});
