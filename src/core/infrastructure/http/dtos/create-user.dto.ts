import { IsBoolean, IsEmail, IsOptional, IsString } from 'class-validator';

export class CreateUserDto {
    @IsString()
    @IsEmail()
    public email: string;

    @IsString()
    @IsOptional()
    public password: string;

    @IsBoolean()
    @IsOptional()
    public status?: boolean;
}
