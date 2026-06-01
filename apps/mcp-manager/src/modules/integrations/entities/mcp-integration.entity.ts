import {
    MCPIntegrationAuthType,
    MCPIntegrationProtocol,
} from '../enums/integration.enum';
import {
    Column,
    CreateDateColumn,
    DeleteDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

@Entity({
    schema: 'mcp-manager',
    name: 'mcp_integrations',
})
export class MCPIntegrationEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'active', type: 'boolean', default: true })
    active: boolean;

    @Column({ name: 'organizationId', type: 'text' })
    organizationId: string;

    @Column({
        name: 'protocol',
        type: 'enum',
        enum: MCPIntegrationProtocol,
        default: MCPIntegrationProtocol.HTTP,
    })
    protocol: MCPIntegrationProtocol;

    @Column({ name: 'baseUrl', type: 'text' })
    baseUrl: string;

    @Column({ name: 'name', type: 'text' })
    name: string;

    @Column({ name: 'description', type: 'text', nullable: true })
    description?: string;

    @Column({ name: 'logoUrl', type: 'text', nullable: true })
    logoUrl?: string;

    @Column({
        name: 'authType',
        type: 'enum',
        enum: MCPIntegrationAuthType,
        default: MCPIntegrationAuthType.NONE,
    })
    authType: MCPIntegrationAuthType;

    @Column({ name: 'auth', type: 'text', nullable: true })
    auth?: string;

    @Column({ name: 'headers', type: 'text', nullable: true })
    headers?: string;

    @CreateDateColumn({ name: 'createdAt' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updatedAt' })
    updatedAt: Date;

    @DeleteDateColumn({ name: 'deletedAt' })
    deletedAt: Date;
}
