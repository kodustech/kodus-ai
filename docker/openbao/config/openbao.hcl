# OpenBao for the Kody Runtime's org secrets (docs/runtime/sandbox.md
# "Secrets: OpenBao"). Unmodified upstream image, MPL-2.0, run as its own
# service; Kodus never links or vendors it.
ui            = false
api_addr      = "https://runtime-openbao:8200"
cluster_addr  = "https://runtime-openbao:8201"
log_level     = "info"

# The Postgres Kodus already runs, in its own database: its backup covers the
# vault. No connection string here: the standard PG* variables and PGPASSFILE
# (or BAO_PG_CONNECTION_URL) of the service name the database and the role.
storage "postgresql" {
  ha_enabled = "false"
}

listener "tcp" {
  address         = "0.0.0.0:8200"
  cluster_address = "0.0.0.0:8201"
  tls_cert_file   = "/openbao/secrets/tls.pem"
  tls_key_file    = "/openbao/secrets/tls.key"
  tls_min_version = "tls12"
}

# Self-hosted default: static key auto-unseal, the 32-byte key the installer
# generates and keeps (https://openbao.org/docs/configuration/seal/static/).
# Kodus Cloud uses the awskms KMS plugin instead.
seal "static" {
  current_key_id = "kodus-runtime-1"
  current_key    = "file:///openbao/secrets/unseal.key"
}

# Every request and response, values HMAC'd, to the container's stdout.
audit "file" "to-stdout" {
  description = "OpenBao audit log"
  options = {
    file_path = "stdout"
  }
}
