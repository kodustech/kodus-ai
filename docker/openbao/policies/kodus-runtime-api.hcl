# The Kodus API: writes, replaces and deletes org secrets for the Runtime.
# It can never read a value back: no "read" on data/, no "list" anywhere.
# "patch" changes the allowed hosts without the value (a JSON merge patch).
# Layout: runtime-kv/data/orgs/<organizationId>/secrets/<secretId>.
path "runtime-kv/data/orgs/+/secrets/+" {
  capabilities = ["create", "update", "patch"]
}

# Delete removes every version, so a deleted secret is gone for the injector.
path "runtime-kv/metadata/orgs/+/secrets/+" {
  capabilities = ["delete"]
}
