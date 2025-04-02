import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { IPasswordService } from '@/core/domain/user/contracts/password.service.contract';

@Injectable()
export class BcryptService implements IPasswordService {
    public generate(value: string, salts = 1): Promise<string> {
        return bcrypt.hash(value, salts);
    }

    public match(source: string, hash: string): Promise<boolean> {
        return bcrypt.compare(source, hash);
    }
}
