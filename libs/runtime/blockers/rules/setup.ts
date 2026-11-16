import { MAX_HEALTH_TIMEOUT_SECONDS } from '@libs/runtime/protocol/recipe';

import type { BlockerFixView, BlockerKindView } from '../catalog';
import { belowErrorLevel } from './log';
import { type BlockerRule, evidenceOf, fixRecipe, retry, SERVICE } from './rule';

// The rules read after the logs: a setup's ready check, a setup step, a recipe
// step that failed after up, and the fallback that keeps what the cell said.

// Owned here, written by the worker's ready check and read by the not_ready card below.
const CUT_BY_CEILING = ", when the setup's machine time ran out";
/**
 * The ready check's "after N s" in a not_ready message. `cutByCeiling`: the
 * setup claim's hardExpiresAt ended the wait before health_timeout did, so a
 * longer health_timeout would be cut the same way and the card proposes none.
 */
export const notReadyWaited = (seconds: number, cutByCeiling: boolean): string => ` after ${seconds} s${cutByCeiling ? CUT_BY_CEILING : ''}`;

const raiseHealthTimeout = (seconds: number): BlockerFixView => ({
    id: 'raise_health_timeout',
    action: 'raise_health_timeout',
    who: 'dev',
    label: 'Give the app more time to start',
    detail: `Opens a PR on the recipe that waits up to ${seconds / 60} minutes for the ready check. If it never answers, check services.compose.health points at a path that returns 200.`,
    recipeChange: { path: ['health_timeout'], value: `${seconds}s` },
});

/**
 * The ready check never answered: a service that listens only inside its
 * container, or an app that needs longer, up to the most a ready check gets.
 */
export const notReadyRule: BlockerRule = {
    id: 'not_ready',
    classify: ({ input, lines }) => {
        if (input.kind !== 'not_ready') return null;
        const m = /^setup:not_ready:([^:]+):(\d+)(\/.*)?$/.exec(input.signature);
        const service = m && SERVICE.test(m[1]) ? m[1] : undefined;
        const port = m ? Number(m[2]) : undefined;
        const notListening = input.bundle?.ports.find((p) => p.service === service && p.port === port && !p.listening);
        if (notListening && service && port) {
            return {
                kind: 'platform',
                signature: `platform:not_listening:${service}:${port}`,
                title: `${service} doesn't listen on port ${port} from outside the container`,
                evidence: evidenceOf(lines.filter((l) => l.service === service).at(-1)),
                fixes: [
                    {
                        id: `fix_listen_address:${service}:${port}`,
                        action: 'fix_listen_address',
                        who: 'dev',
                        label: 'Listen on 0.0.0.0',
                        detail: `The service probably binds to 127.0.0.1. Start it with the host 0.0.0.0 (HOST=0.0.0.0, --host 0.0.0.0) on port ${port}.`,
                    },
                ],
            };
        }
        // The setup waited `after N s` for the app; a longer wait is proposed, up to the most a ready check gets.
        // A blocker is a persisted kind and message with no wait field, so the wait is read back from the
        // text `notReadyWaited` wrote.
        const waited = Number(/after (\d+) s\b/.exec(input.message)?.[1] ?? 0);
        const longer = input.message.includes(CUT_BY_CEILING) ? waited : Math.min(Math.max(waited * 2, 180), MAX_HEALTH_TIMEOUT_SECONDS);
        return {
            kind: 'not_ready',
            signature: input.signature,
            title: input.message.slice(0, 200),
            evidence: evidenceOf(lines.filter((l) => !service || l.service === service).at(-1)),
            fixes: [...(longer > waited ? [raiseHealthTimeout(longer)] : []), retry],
        };
    },
};

/** A setup step the worker named with a known kind and no log rule read: Kodus's, retried. */
export const setupSignatureRule: BlockerRule = {
    id: 'setup_signature',
    classify: ({ input }) =>
        input.signature.startsWith('setup:') && input.kind !== 'unknown'
            ? {
                  kind: 'platform',
                  signature: input.signature,
                  title: input.message.slice(0, 200),
                  evidence: evidenceOf({ text: input.message }),
                  fixes: [retry],
              }
            : null,
};

/** The cell's signatures for a failed recipe boot step (agent runRecipe), by the recipe key it names. */
const RECIPE_STEP_SIGNATURES: Record<string, string> = { recipe_setup: 'setup', recipe_migrate: 'data.migrate', recipe_seed: 'data.seed' };

/**
 * A recipe step the cell ran in the app's container after up (setup, data.migrate, data.seed) failed,
 * and no rule above read its output: the command is the dev's to fix.
 */
export const recipeStepRule: BlockerRule = {
    id: 'recipe_step',
    classify: ({ input }) => {
        const recipeStep = Object.hasOwn(RECIPE_STEP_SIGNATURES, input.signature) ? RECIPE_STEP_SIGNATURES[input.signature] : undefined;
        if (!recipeStep) return null;
        return {
            kind: input.kind === 'toolchain' ? 'toolchain' : 'seed_data',
            signature: input.signature,
            title: `The recipe's ${recipeStep} failed`,
            evidence: evidenceOf({ text: input.message }),
            fixes: [
                fixRecipe(
                    `Fix ${recipeStep} in .kodus/workspace.yaml on the default branch. A cell runs it in the public service's container once the project is up (a data.seed mapping in the service it names); its output is in the setup's progress.`,
                ),
                retry,
            ],
        };
    },
};

/** A container state the cell reports for a service that stopped with an error: "Exited (1) …", not "Exited (0)". */
const EXITED_WITH_ERROR = /^exited \((?!0\))\d+\)/i;
/** The line a crashing process writes about why: an error, an exception, a panic. */
const ERROR_LINE = /\b(?:[A-Z][A-Za-z]*Error|Error|Exception|FATAL|panic)\b[:!]?\s/;

/**
 * A service of the app exited with an error at boot and no rule read why:
 * its own last error line is the evidence. It is the app failing with what
 * the recipe gave it, so the card quotes it and offers no retry (a new setup
 * with the same recipe fails the same way).
 */
export const serviceExitedRule: BlockerRule = {
    id: 'service_exited',
    classify: ({ input }) => {
        // An image build that failed is the build's output, not a service's boot.
        if (input.signature !== 'compose_up' || /\bbuild \S+: |did not complete successfully/.test(input.message)) return null;
        const svc = (input.bundle?.services ?? []).find((s) => EXITED_WITH_ERROR.test(s.state ?? '') && SERVICE.test(s.name));
        if (!svc) return null;
        const line = [...svc.logTail].reverse().find((t) => !belowErrorLevel(t) && ERROR_LINE.test(t));
        const known = (KNOWN_KINDS as readonly string[]).includes(input.kind) ? (input.kind as BlockerKindView) : 'unknown';
        return {
            kind: known,
            signature: `service_exited:${svc.name}`,
            title: `The ${svc.name} service stopped with an error while the app booted`,
            evidence: evidenceOf({ service: svc.name, text: line ?? svc.logTail.at(-1) ?? input.message }),
            fixes: [
                {
                    id: 'read_service_error',
                    action: 'fix_recipe',
                    who: 'dev',
                    label: `Fix what ${svc.name} stopped on`,
                    detail: `The ${svc.name} container exited before the app answered; its log is under Health. It is the app's own error, most often a value the recipe sets, or one it leaves unset, in a format the app refuses. A new setup with the same recipe fails the same way.`,
                },
            ],
        };
    },
};

const KNOWN_KINDS = ['missing_env', 'external_service', 'toolchain', 'native_dep', 'resources', 'seed_data', 'other_repo', 'platform'] as const;

/** No rule read the logs: keep what the cell said, and show the last log line. Always reads; it is the last rule. */
export const fallbackRule: BlockerRule = {
    id: 'fallback',
    classify: ({ input, lines }) => {
        const known = (KNOWN_KINDS as readonly string[]).includes(input.kind) ? (input.kind as BlockerKindView) : 'unknown';
        return {
            kind: known,
            signature: input.signature,
            title: input.signature === 'compose_up' ? 'The project failed to build or start' : input.message.slice(0, 200) || 'The environment could not boot',
            evidence: evidenceOf(lines.filter((l) => l.service).at(-1) ?? lines.at(-1)),
            fixes: [retry],
        };
    },
};
