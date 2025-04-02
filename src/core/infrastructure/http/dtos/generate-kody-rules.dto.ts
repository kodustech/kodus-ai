import { IsArray, IsNumber, IsOptional, IsString } from 'class-validator';

export class GenerateKodyRulesDTO {
    @IsString()
    teamId: string;

    @IsNumber()
    @IsOptional()
    months?: number;

    @IsNumber()
    @IsOptional()
    weeks?: number;

    @IsNumber()
    @IsOptional()
    days?: number;

    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    repositoriesIds?: string[];
}
