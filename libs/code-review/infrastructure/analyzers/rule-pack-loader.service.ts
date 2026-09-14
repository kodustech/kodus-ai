import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';

/**
 * Reads the rule pack off disk once, so the pipeline can write it into a
 * sandbox without touching the filesystem per review.
 *
 * The YAML lives beside this file and is copied into `dist` by a webpack
 * afterEmit plugin — `nest-cli.json -> assets` is ignored under the webpack
 * builder, the same reason the skills and dictionaries assets are copied that
 * way.
 */
@Injectable()
export class RulePackLoader {
    private readonly logger = createLogger(RulePackLoader.name);
    private cached: Record<string, string> | null = null;

    /** Rule file name → YAML contents. Empty when the pack is missing. */
    load(): Record<string, string> {
        if (this.cached) {
            return this.cached;
        }

        // Webpack bundles every module into one file, so `__dirname` is the
        // bundle's own directory (dist/apps/<app>), not this file's path in the
        // source tree. Try the colocated path first for unbundled runs, then
        // the copied dist location, then the source tree for local dev.
        const relative = 'libs/code-review/infrastructure/analyzers/rule-pack';
        const candidates = [
            join(__dirname, 'rule-pack'),
            join(process.cwd(), 'dist', relative),
            join(process.cwd(), relative),
        ];

        const pack: Record<string, string> = {};

        for (const dir of candidates) {
            try {
                for (const name of readdirSync(dir)) {
                    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) {
                        continue;
                    }
                    pack[name] = readFileSync(join(dir, name), 'utf8');
                }
            } catch {
                continue;
            }
            if (Object.keys(pack).length > 0) {
                return (this.cached = pack);
            }
        }

        // An empty pack disables the analyzer pass rather than failing a
        // review — same posture as a missing binary.
        this.logger.warn({
            message: 'Security rule pack not found on disk',
            context: RulePackLoader.name,
            metadata: { candidates },
        });

        this.cached = pack;
        return pack;
    }
}
