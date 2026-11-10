import picomatch from 'picomatch';
import { z } from 'zod';
import {
    createGlobPatternValidator,
    MAX_FILE_PATTERNS,
    MAX_FILE_PATTERN_LENGTH,
} from '@libs/common/utils/glob-pattern-validation';

const { checkIgnorePattern } = createGlobPatternValidator(picomatch);
export const filePatternSchema = z
    .string()
    .trim()
    .min(1)
    .max(MAX_FILE_PATTERN_LENGTH)
    .refine(
        (pattern) => checkIgnorePattern(pattern).valid,
        'Use a valid file glob without negation.',
    );
export const filePatternListSchema = z
    .array(filePatternSchema)
    .max(MAX_FILE_PATTERNS);
