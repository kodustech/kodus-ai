import { UserRole } from '@/core/domain/user/enums/userRole.enum';
import { Request } from 'express';

type User = { id: string; role: UserRole[] };

export type UserRequest = Request & { user: User };
