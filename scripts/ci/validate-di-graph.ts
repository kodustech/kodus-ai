/**
 * Validates that the Nest dependency-injection graph actually resolves.
 *
 * WHY THIS EXISTS
 * ---------------
 * A missing provider is a *runtime* failure raised while Nest builds the
 * container, so nothing else in CI can see it:
 *   - `nest build` / `tsc --noEmit` only compile. A constructor parameter
 *     whose provider is not registered in that module is perfectly valid
 *     TypeScript.
 *   - The unit suites instantiate classes directly (or through a
 *     purpose-built `Test.createTestingModule`), never the real ApiModule
 *     graph.
 *
 * The concrete miss this guards against: a class is registered by *two*
 * modules, a PR adds a constructor dependency, and only one of the two
 * modules gets the corresponding `imports:` entry. The app then dies on
 * boot. `grep -rn "<StageName>" libs --include="*.module.ts"` shows the
 * asymmetry, but only if somebody remembers to run it.
 *
 * HOW IT WORKS
 * ------------
 * `preview: true` walks the whole module graph and resolves every
 * constructor's dependencies, but never instantiates a provider — the
 * guard lives inside Nest's `instantiateClass`, while
 * `resolveConstructorParams` runs unguarded. So we get full DI validation
 * with no constructor bodies, meaning no database, Redis, RabbitMQ or
 * HTTP connections are opened.
 *
 * `abortOnError: false` makes Nest throw the resolution error instead of
 * logging a partial message and killing the process itself, which lets us
 * print the full "Nest can't resolve dependencies of X ... available in
 * the Y module" text — the part that names the module you forgot.
 */
import { NestFactory } from '@nestjs/core';

import { ApiModule } from '../../apps/api/src/api.module';

/**
 * Belt-and-braces: the whole point of this job is to be fast and
 * deterministic. If some module-level import ever starts waiting on a
 * socket, fail loudly instead of burning the CI job's wall clock.
 */
const TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
    const startedAt = process.hrtime.bigint();

    const timeout = setTimeout(() => {
        console.error(
            `\n[di-graph] TIMED OUT after ${TIMEOUT_MS}ms building the module graph.\n` +
                `[di-graph] Building the graph should never block — something is ` +
                `opening a connection at import time.`,
        );
        process.exit(1);
    }, TIMEOUT_MS);
    // Do not hold the event loop open just for the watchdog.
    timeout.unref();

    console.log('[di-graph] building ApiModule graph (preview mode)...');

    const context = await NestFactory.createApplicationContext(ApiModule, {
        // Resolve every dependency, instantiate nothing.
        preview: true,
        // Throw on failure instead of process.exit()-ing with a truncated log.
        abortOnError: false,
        // Drop the per-module "dependencies initialized" chatter; keep anything
        // that signals a real problem.
        logger: ['error', 'warn'],
    });

    await context.close();
    clearTimeout(timeout);

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(
        `[di-graph] OK — ApiModule resolves (${elapsedMs.toFixed(0)}ms).`,
    );
}

main()
    .then(() => {
        // Module-level imports can leave timers/handles open even though we
        // never instantiated a provider. Exit explicitly so the job ends.
        process.exit(0);
    })
    .catch((error: unknown) => {
        console.error('\n[di-graph] FAILED — the module graph does not resolve.\n');
        console.error(error instanceof Error ? error.message : error);

        if (error instanceof Error && error.stack) {
            console.error('\n--- stack ---');
            console.error(error.stack);
        }

        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('cannot export a provider/module')) {
            // UnknownExportException: a module lists a token in `exports:` that
            // it does not own. Nest only lets you export a token from your own
            // `providers:`, or re-export a whole imported module class.
            console.error(
                '\n[di-graph] Fix: a module can only export a token it declares in its own\n' +
                    '[di-graph] `providers:`. To pass along a token owned by a module you import,\n' +
                    '[di-graph] re-export that module instead:\n' +
                    '[di-graph]   exports: [ /* the Module */ ]   // not the token\n',
            );
        } else {
            // Missing provider: the class is registered in a module whose
            // imports do not reach the provider it needs.
            console.error(
                '\n[di-graph] Fix: every module that registers the class above needs the\n' +
                    '[di-graph] module exporting the missing provider in its `imports:`.\n' +
                    '[di-graph] A class registered by more than one module needs the import in\n' +
                    '[di-graph] EACH of them. Find all registration sites with:\n' +
                    '[di-graph]   grep -rn "<ClassName>" libs apps --include="*.module.ts"\n',
            );
        }
        process.exit(1);
    });
