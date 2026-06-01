import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import { UserModel } from './user.model';

export type CliAuthSessionMode = 'loopback' | 'device';
export type CliAuthSessionStatus =
    | 'pending'
    | 'completed'
    | 'consumed'
    | 'denied'
    | 'expired';

@Entity('cli_auth_sessions')
@Index('UQ_cli_auth_sessions_state', ['state'], { unique: true })
@Index('UQ_cli_auth_sessions_device_code', ['deviceCode'], {
    unique: true,
    where: "device_code IS NOT NULL ",
})
@Index('UQ_cli_auth_sessions_user_code', ['userCode'], {
    unique: true,
    where: "user_code IS NOT NULL AND status = 'pending'",
})
@Index('IDX_cli_auth_sessions_status_expires', ['status', 'expiresAt'])
export class CliAuthSessionModel extends CoreModel {
    @Column({ type: 'varchar', length: 64 })
    state: string;

    @Column({ type: 'varchar', length: 64, nullable: true, name: 'device_code' })
    deviceCode?: string | null;

    @Column({ type: 'varchar', length: 16, nullable: true, name: 'user_code' })
    userCode?: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true, name: 'redirect_uri' })
    redirectUri?: string | null;

    @Column({ type: 'varchar', length: 16, default: 'loopback' })
    mode: CliAuthSessionMode;

    @Column({ type: 'varchar', length: 16, default: 'pending' })
    status: CliAuthSessionStatus;

    @Column({ type: 'text', nullable: true, name: 'access_token' })
    accessToken?: string | null;

    @Column({ type: 'text', nullable: true, name: 'refresh_token' })
    refreshToken?: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true, name: 'user_email' })
    userEmail?: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true, name: 'user_agent' })
    userAgent?: string | null;

    @Column({ type: 'timestamp', name: 'expires_at' })
    expiresAt: Date;

    @Column({ type: 'timestamp', nullable: true, name: 'consumed_at' })
    consumedAt?: Date | null;

    @Column({ type: 'timestamp', nullable: true, name: 'completed_at' })
    completedAt?: Date | null;

    @ManyToOne(() => UserModel, { nullable: true })
    @JoinColumn({ name: 'user_id', referencedColumnName: 'uuid' })
    user?: UserModel | null;
}
