import { BehaviourForExistingDescription } from '@/config/types/general/codeReview.type';
import {
    IsEnum,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
} from 'class-validator';

export class PreviewPrSummaryDto {
    @IsNotEmpty()
    @IsString()
    prNumber: string;

    @IsNotEmpty()
    @IsObject()
    repository: {
        id: string;
        name: string;
    };

    @IsNotEmpty()
    @IsString()
    teamId: string;

    @IsNotEmpty()
    @IsEnum(BehaviourForExistingDescription)
    behaviourForExistingDescription: BehaviourForExistingDescription;

    @IsOptional()
    @IsString()
    customInstructions: string;
}
