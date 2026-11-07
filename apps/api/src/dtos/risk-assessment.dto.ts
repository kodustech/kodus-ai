import {
    IsArray,
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    ArrayMaxSize,
} from 'class-validator';

export class PreviewPrRiskDto {
    @IsString()
    @IsNotEmpty()
    teamId: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    repositoryId: string;

    @IsInt()
    @Min(1)
    @Max(Number.MAX_SAFE_INTEGER)
    prNumber: number;

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    criteria?: unknown[];
}
