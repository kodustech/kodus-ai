import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

import { ReviewPreset } from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamDataDto } from './organizationAndTeamData.dto';

export class ApplyCodeReviewPresetDto {
    @IsEnum(ReviewPreset)
    preset: ReviewPreset;

    @IsNotEmpty()
    @IsString()
    teamId: string;

    @IsOptional()
    organizationAndTeamData?: OrganizationAndTeamDataDto;
}
