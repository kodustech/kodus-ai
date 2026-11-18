# The cell's injector: reads the current value of an org secret, nothing else.
# A dedicated cell (self-hosted, or one org's own cell) narrows "+" after orgs/
# to its organization id (docs/runtime/cell-distribution.md item 10).
path "runtime-kv/data/orgs/+/secrets/+" {
  capabilities = ["read"]
}
