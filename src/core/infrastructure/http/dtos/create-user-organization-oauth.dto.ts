import { AuthProvider } from '@/shared/domain/enums/auth-provider.enum';
import { IsEmail, IsString, IsEnum } from 'class-validator';

export class CreateUserOrganizationOAuthDto {
    @IsString()
    public name: string;

    @IsString()
    @IsEmail()
    public email: string;

    @IsString()
    public refreshToken: string;

    @IsEnum(AuthProvider)
    public authProvider: AuthProvider;
}
