import { ProgrammingLanguage } from "src/core/enums/programming-language";

export interface RuleLike {
    ruleId: string;
    likeCount: number;
    userLiked: boolean;
    language?: (typeof ProgrammingLanguage)[keyof typeof ProgrammingLanguage];
}
