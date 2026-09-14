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

        const dir = join(__dirname, 'rule-pack');
        const pack: Record<string, string> = {};

        try {
            for (const name of readdirSync(dir)) {
                if (!name.endsWith('.yaml') && !name.endsWith('.yml')) {
                    continue;
                }
                pack[name] = readFileSync(join(dir, name), 'utf8');
            }
        } catch (error) {
            // An empty pack disables the analyzer pass rather than failing a
            // review — same posture as a missing binary.
            this.logger.warn({
                message: 'Security rule pack not found on disk',
                context: RulePackLoader.name,
                error,
                metadata: { dir },
            });
        }

        this.cached = pack;
        return pack;
    }
}
