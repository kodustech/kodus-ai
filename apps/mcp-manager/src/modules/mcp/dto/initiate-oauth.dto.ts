import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class InitiateOAuthDto {
    @ApiProperty({ example: 'int_456' })
    @IsString()
    integrationId: string;
}
