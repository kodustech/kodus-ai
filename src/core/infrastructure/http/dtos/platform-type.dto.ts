import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import {  IsEnum,  } from 'class-validator';

export class PlatformTypeDto {
    @IsEnum(PlatformType)
    platformType: PlatformType;
}
