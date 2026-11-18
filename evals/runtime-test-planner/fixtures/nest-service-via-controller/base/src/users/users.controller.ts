import { Controller, Get, Param } from '@nestjs/common';

@Controller('users')
export class UsersController {
    @Get(':id')
    find(@Param('id') id: string) {
        return { id, name: `user ${id}` };
    }
}
