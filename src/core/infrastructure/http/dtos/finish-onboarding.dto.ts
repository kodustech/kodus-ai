import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

export class FinishOnboardingDTO {
    @IsString()
    teamId: string;

    @IsBoolean()
    reviewPR: boolean;

    @IsOptional()
    @IsString()
    repositoryId?: string;

    @IsOptional()
    @IsString()
    repositoryName?: string;

    @IsOptional()
    @IsNumber()
    pullNumber?: number;
}
