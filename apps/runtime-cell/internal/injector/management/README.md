# Owner-local secret administration

The optional Unix management socket belongs to the running injector. Both peers
must have the same OS UID; the parent directory is 0700 and the socket is 0600.
The client verifies ownership and socket identity before sending a request. No
TCP listener, product authentication or secret-read endpoint is added here.

`injector-admin -socket /private/owner/admin.sock -operation register-external`
reads this metadata-only request from stdin:

```json
{
  "organizationId": "org-a",
  "environmentId": "env-a",
  "id": "payments",
  "version": 3,
  "expiresAt": "2030-01-01T01:00:00Z"
}
```

This operation registers an exact immutable version and its upper expiry bound.
It does not fetch a value, write a value, grant a claim or check whether the remote
version exists. Values are fetched only on an independently authorized lookup.
An identical registration is idempotent; a changed or revoked record conflicts.

The running process must already be configured in external-value mode, with the
reader and its immutable owner-controlled source identity. The request cannot
choose a source, endpoint, mount, authentication token or mode. Extra fields,
including `value`, are refused. Recovery rejects a different source identity.
Local-value mode refuses `register-external`; external mode refuses `put`.

All six operations (`put`, `register-external`, `list`, `bind`, `revoke-version`,
`revoke-claim`) use strict bounded JSON with exact fields, no duplicate keys and
no unknown fields. Requests are limited to 16 KiB. Only `list` returns canonical
bounded metadata; mutation responses have no body. Provider and transport errors
are fixed codes without request input or raw backend details. Cancellation reaches
the vault operation; existing durable version/claim revocation remains authoritative.

This transport does not enable normal Run credential references or automatic
grants. Immutable reader profiles, renewable backend identity, product CRUD/RBAC,
installer/backup/restore, private registry and two-stage bake acceptance remain
separate deliveries. Configuring this operation does not install OpenBao.
