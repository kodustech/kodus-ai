import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class EncryptionUtils {
    private readonly algorithm = 'aes-256-cbc';
    private readonly key: Buffer;
    private static readonly IV_LENGTH = 16;
    private static readonly KEY_LENGTH = 32;

    constructor(private readonly configService: ConfigService) {
        const secret = this.configService.get<string>('encryption.secret');

        if (!secret) {
            throw new Error('Missing encryption configuration: secret');
        }

        this.key = crypto.createHash('sha256').update(secret).digest();
    }

    encrypt(data: string): string {
        try {
            const iv = crypto.randomBytes(EncryptionUtils.IV_LENGTH);

            const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

            let encrypted = cipher.update(data, 'utf8', 'base64');
            encrypted += cipher.final('base64');

            return `${iv.toString('hex')}:${encrypted}`;
        } catch (error) {
            console.error('Encryption failed:', error.message);
            throw new Error('Encryption failed.');
        }
    }

    decrypt(data: string): string {
        try {
            const parts = data.split(':');
            if (parts.length !== 2) {
                throw new Error(
                    'Invalid encrypted data format. Expected "iv:ciphertext"',
                );
            }

            const iv = Buffer.from(parts[0], 'hex');

            if (iv.length !== EncryptionUtils.IV_LENGTH) {
                throw new Error(
                    `Invalid IV length. Expected ${EncryptionUtils.IV_LENGTH} bytes.`,
                );
            }

            const encryptedText = parts[1];

            const decipher = crypto.createDecipheriv(
                this.algorithm,
                this.key,
                iv,
            );

            let decrypted = decipher.update(encryptedText, 'base64', 'utf8');
            decrypted += decipher.final('utf8');

            return decrypted;
        } catch (error) {
            console.error('Decryption failed:', error.message);
            throw new Error('Decryption failed.');
        }
    }
}
