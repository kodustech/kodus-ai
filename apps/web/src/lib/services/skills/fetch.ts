import { authorizedFetch } from "@services/fetch";
import { pathToApiUrl } from "src/core/utils/helpers";

import type { SkillInstructions, SkillMeta } from "./types";

export const SKILLS_PATHS = {
    GET_META: (skillName: string) => pathToApiUrl(`/skills/${skillName}/meta`),
    GET_INSTRUCTIONS: (skillName: string) =>
        pathToApiUrl(`/skills/${skillName}/instructions`),
};

export const getSkillMeta = (skillName: string) =>
    authorizedFetch<SkillMeta>(SKILLS_PATHS.GET_META(skillName));

export const getSkillInstructions = (skillName: string) =>
    authorizedFetch<SkillInstructions>(
        SKILLS_PATHS.GET_INSTRUCTIONS(skillName),
    );
