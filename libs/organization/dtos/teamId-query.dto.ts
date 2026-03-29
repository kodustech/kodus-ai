import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TeamQueryDto {
    @IsUUID()
    @ApiProperty()
    teamId: string;
}
