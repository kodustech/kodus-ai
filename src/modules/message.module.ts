import { Module } from '@nestjs/common';
import { DatabaseModule } from './database.module';

@Module({
    imports: [DatabaseModule],
    providers: [
    ],
    exports: [],
})
export class MessageModule { }
