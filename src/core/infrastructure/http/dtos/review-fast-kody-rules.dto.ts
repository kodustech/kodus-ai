import { IsArray, IsOptional, IsString } from 'class-validator';

export class ReviewFastKodyRulesDto {
    @IsString()
    teamId: string;

    @IsOptional()
    @IsArray()
    activateRuleIds?: string[];

    @IsOptional()
    @IsArray()
    deleteRuleIds?: string[];
}
