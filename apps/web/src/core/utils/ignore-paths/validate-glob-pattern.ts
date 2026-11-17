import { createGlobPatternValidator } from "@libs/common/utils/glob-pattern-validation";
import picomatch from "picomatch";

export type { GlobPatternCheck } from "@libs/common/utils/glob-pattern-validation";
export const { checkGlobPatternSyntax, checkIgnorePattern } =
    createGlobPatternValidator(picomatch);
