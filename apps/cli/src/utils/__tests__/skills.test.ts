import { describe, expect, it } from 'vitest';
import { readBundledSkills } from '../skills.js';

describe('bundled skills', () => {
    it('rejects unsafe skill names', async () => {
        await expect(readBundledSkills(['../secrets'])).rejects.toThrow(
            'Invalid skill name',
        );
    });
});
