import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const algorithm = 'aes-256-cbc';
const key = Buffer.from(process.env.CODE_MANAGEMENT_SECRET || '', 'hex');

if (key.length !== 32) {
    throw new Error('CODE_MANAGEMENT_SECRET must be 32 bytes in hexadecimal.');
}

const TOKEN_PLAIN = process.env.CODE_MANAGEMENT_WEBHOOK_TOKEN;

if (!TOKEN_PLAIN) {
    throw new Error('CODE_MANAGEMENT_WEBHOOK_TOKEN is required.');
}

export function generateWebhookToken(): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(TOKEN_PLAIN, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

export function validateWebhookToken(encryptedText: string): boolean {
    try {
        const [ivHex, encrypted] = encryptedText.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = createDecipheriv(algorithm, key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted === TOKEN_PLAIN;
    } catch {
        return false;
    }
}
