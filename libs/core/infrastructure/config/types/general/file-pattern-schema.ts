import picomatch from 'picomatch';
import { z } from 'zod';
import { createGlobPatternValidator } from '@libs/common/utils/glob-pattern-validation';

const { checkIgnorePattern } = createGlobPatternValidator(picomatch);
export const filePatternSchema = z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine(
        (pattern) => checkIgnorePattern(pattern).valid,
        'Use a valid file glob without negation.',
    );
export const filePatternListSchema = z.array(filePatternSchema).max(100);
