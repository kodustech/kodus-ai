import {
    IsNotEmpty,
    IsOptional,
    IsString,
    IsStrongPassword,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AcceptUserInvitationDto {
    @ApiProperty({
        description: 'Invitation token from the invitation link.',
    })
    @IsString()
    @IsNotEmpty()
    public token: string;

    @ApiProperty({ example: 'Jane Doe' })
    @IsString()
    public name: string;

    @ApiProperty({
        format: 'password',
        example: 'Str0ngP@ssw0rd!',
    })
    @IsString()
    @IsStrongPassword({
        minLength: 8,
        minLowercase: 1,
        minUppercase: 1,
        minNumbers: 1,
        minSymbols: 1,
    })
    public password: string;

    @ApiPropertyOptional({ example: '+1-555-0100' })
    @IsString()
    @IsOptional()
    public phone?: string;
}
