import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    Unique,
    UpdateDateColumn,
} from 'typeorm';
import { MCPIntegrationOAuthStatus } from '../enums/integration.enum';

@Entity({
    schema: 'mcp-manager',
    name: 'mcp_integration_oauth',
})
@Unique(['organizationId', 'integrationId'])
export class MCPIntegrationOAuthEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({
        name: 'status',
        type: 'enum',
        enum: MCPIntegrationOAuthStatus,
        default: MCPIntegrationOAuthStatus.INACTIVE,
    })
    status: MCPIntegrationOAuthStatus;

    @Column({ name: 'organizationId', type: 'text' })
    organizationId: string;

    @Column({ name: 'integrationId', type: 'text' })
    integrationId: string;

    @Column({ name: 'auth', type: 'text', nullable: true })
    auth?: string;

    @CreateDateColumn({ name: 'createdAt' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updatedAt' })
    updatedAt: Date;
}
