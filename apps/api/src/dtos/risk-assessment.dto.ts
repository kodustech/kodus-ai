import {
    IsArray,
    IsBoolean,
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

class PreviewPrDto {
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
}

export class PreviewPrRiskDto extends PreviewPrDto {
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @Type(() => Object)
    criteria?: unknown[];
}

export class PreviewPrApprovalDto extends PreviewPrDto {
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @Type(() => Object)
    policies?: unknown[];

    @IsOptional()
    @IsBoolean()
    assumeClean?: boolean;

    @IsOptional()
    @IsBoolean()
    assumeEnabled?: boolean;
}
