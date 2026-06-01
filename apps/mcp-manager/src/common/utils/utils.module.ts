import { Module } from '@nestjs/common';
import { EncryptionUtils } from './encryption';

@Module({
    providers: [EncryptionUtils],
    exports: [EncryptionUtils],
})
export class UtilsModule {}
