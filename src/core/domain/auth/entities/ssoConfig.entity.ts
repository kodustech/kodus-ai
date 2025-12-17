import { Entity } from '@/shared/domain/interfaces/entity';
import { IOrganization } from '../../organization/interfaces/organization.interface';
import {
    SSOConfig,
    SSOProtocol,
    SSOProtocolConfigMap,
} from '../interfaces/ssoConfig.interface';

export class SSOConfigEntity<P extends SSOProtocol>
    implements Entity<SSOConfig<P>>
{
    private _uuid: string;
    private _organization: Partial<IOrganization>;
    private _protocol: P;
    private _active: boolean;
    private _providerConfig: SSOProtocolConfigMap[P];
    private _domains: string[];
    private _createdAt: Date;
    private _updatedAt: Date;

    constructor(sso: SSOConfig<P> | Partial<SSOConfig<P>>) {
        this._uuid = sso.uuid;
        this._organization = sso.organization;
        this._protocol = sso.protocol;
        this._active = sso.active;
        this._providerConfig = sso.providerConfig;
        this._domains = sso.domains;
        this._createdAt = sso.createdAt;
        this._updatedAt = sso.updatedAt;
    }

    public static create<P extends SSOProtocol>(
        sso: SSOConfig<P> | Partial<SSOConfig<P>>,
    ): SSOConfigEntity<P> {
        return new SSOConfigEntity<P>(sso);
    }

    public toObject(): SSOConfig<P> {
        return {
            uuid: this.uuid,
            organization: this.organization,
            protocol: this.protocol,
            active: this.active,
            providerConfig: this.providerConfig,
            domains: this.domains,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
        };
    }

    public toJson(): SSOConfig<P> | Partial<SSOConfig<P>> {
        return this.toObject();
    }

    public get uuid() {
        return this._uuid;
    }

    public get organization() {
        return this._organization;
    }

    public get protocol() {
        return this._protocol;
    }

    public get active() {
        return this._active;
    }

    public get providerConfig() {
        return this._providerConfig;
    }

    public get domains() {
        return this._domains;
    }

    public get createdAt() {
        return this._createdAt;
    }

    public get updatedAt() {
        return this._updatedAt;
    }
}
