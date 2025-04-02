import {
    IsArray,
    IsEnum,
    IsNumber,
    IsOptional,
    IsString,
} from 'class-validator';
import { AlignmentLevel } from '../../adapters/services/codeBase/types/commentAnalysis.type';

export class GenerateCodeReviewParameterDTO {
    @IsString()
    teamId: string;

    @IsEnum(AlignmentLevel)
    @IsOptional()
    alignmentLevel?: AlignmentLevel;

    @IsNumber()
    @IsOptional()
    months?: number;

    @IsNumber()
    @IsOptional()
    weeks?: number;

    @IsNumber()
    @IsOptional()
    days?: number;
}
