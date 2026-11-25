import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';

export class SetConnectionAccessDto {
    @ApiProperty({
        type: [String],
        description:
            'Every member who reads the connection; an empty list revokes all.',
    })
    @IsArray()
    @IsString({ each: true })
    userIds: string[];
}
