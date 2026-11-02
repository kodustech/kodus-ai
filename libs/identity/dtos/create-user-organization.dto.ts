import { IsEmail, IsString, IsStrongPassword } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SignUpDTO {
    @ApiProperty({ example: 'Jane Doe' })
    @IsString()
    public name: string;

    @ApiProperty({ format: 'email', example: 'jane.doe@example.com' })
    @IsString()
    @IsEmail()
    public email: string;

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
}
