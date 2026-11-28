import { createHash } from 'crypto';
import {
    COMPILER_SYSTEM_PROMPT,
    DETECTOR_COMPILER_VERSION,
} from './kody-rules-detector.compiler';

describe('DETECTOR_COMPILER_VERSION', () => {
    // Fails when the compiler prompt changes. If the change should reach rules
    // nobody edits, bump DETECTOR_COMPILER_VERSION; either way, update both
    // values here so the decision is made on purpose.
    it('is reviewed whenever COMPILER_SYSTEM_PROMPT changes', () => {
        const promptSha = createHash('sha256')
            .update(COMPILER_SYSTEM_PROMPT)
            .digest('hex');
        expect({ version: DETECTOR_COMPILER_VERSION, promptSha }).toEqual({
            version: 1,
            promptSha:
                '932b4bbeeb6187c32ebb20c57b09c5edc67bb41ff931434116a88a4ab53341bb',
        });
    });
});
