import { LanguageSurface } from '../surface.types';
import { cFamilyPatterns } from './c-family.shared';

export const C_SURFACE: LanguageSurface = {
    language: 'c',
    glob: '*.{c,h}',
    patterns: cFamilyPatterns('c'),
};
