import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class AreaRiskMapQueryDto {
    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    repositoryId: string;
}
