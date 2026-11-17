import {
    IsEmail,
    IsEnum,
    IsObject,
    IsOptional,
    IsString,
} from 'class-validator';

import { AuthProvider } from '@libs/core/domain/enums/auth-provider.enum';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateUserOrganizationOAuthDto {
    @IsString()
    @ApiProperty({ example: 'Jane Doe' })
    public name: string;

    @IsString()
    @IsEmail()
    @ApiProperty({ format: 'email', example: 'jane.doe@example.com' })
    public email: string;

    @IsString()
    @ApiProperty({ example: '{{oauthRefreshToken}}' })
    public refreshToken: string;

    @IsEnum(AuthProvider)
    @ApiProperty({
        enum: AuthProvider,
        enumName: 'AuthProvider',
        example: AuthProvider.GOOGLE,
    })
    public authProvider: AuthProvider;

    @ApiPropertyOptional({
        type: 'object',
        additionalProperties: true,
        description:
            'First-touch attribution from the kodus_first_touch cookie. Stored only when this login creates the organization.',
    })
    @IsOptional()
    @IsObject()
    public firstTouch?: Record<string, unknown>;
}
