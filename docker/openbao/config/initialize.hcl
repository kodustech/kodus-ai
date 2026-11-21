# Runs once, on the first start against empty storage (self-initialization,
# https://openbao.org/docs/configuration/self-init/). No root token survives
# it and none is ever printed. The role and secret ids come from files the
# installer (or scripts/runtime/dev-openbao.sh) writes.
initialize "runtime" {
  request "mount-kv" {
    operation = "update"
    path      = "sys/mounts/runtime-kv"
    data = {
      type        = "kv"
      description = "Kody Runtime org secrets"
      options = {
        version = "2"
      }
    }
  }

  request "policy-api" {
    operation = "update"
    path      = "sys/policies/acl/kodus-runtime-api"
    data = {
      policy = {
        eval_source = "file"
        eval_type   = "string"
        path        = "/openbao/policies/kodus-runtime-api.hcl"
      }
    }
  }

  request "policy-injector" {
    operation = "update"
    path      = "sys/policies/acl/kodus-runtime-injector"
    data = {
      policy = {
        eval_source = "file"
        eval_type   = "string"
        path        = "/openbao/policies/kodus-runtime-injector.hcl"
      }
    }
  }

  request "enable-approle" {
    operation = "update"
    path      = "sys/auth/approle"
    data = {
      type = "approle"
    }
  }

  request "role-api" {
    operation = "update"
    path      = "auth/approle/role/kodus-runtime-api"
    data = {
      token_policies          = ["kodus-runtime-api"]
      token_no_default_policy = true
      token_ttl               = "1h"
      token_max_ttl           = "4h"
      secret_id_ttl           = "0"
    }
  }

  request "role-api-id" {
    operation = "update"
    path      = "auth/approle/role/kodus-runtime-api/role-id"
    data = {
      role_id = {
        eval_source = "file"
        eval_type   = "string"
        path        = "/openbao/secrets/api-role-id"
      }
    }
  }

  request "role-api-secret" {
    operation = "update"
    path      = "auth/approle/role/kodus-runtime-api/custom-secret-id"
    data = {
      secret_id = {
        eval_source = "file"
        eval_type   = "string"
        path        = "/openbao/secrets/api-secret-id"
      }
    }
  }

  request "role-injector" {
    operation = "update"
    path      = "auth/approle/role/kodus-runtime-injector"
    data = {
      token_policies          = ["kodus-runtime-injector"]
      token_no_default_policy = true
      token_ttl               = "1h"
      token_max_ttl           = "4h"
      secret_id_ttl           = "0"
    }
  }

  request "role-injector-id" {
    operation = "update"
    path      = "auth/approle/role/kodus-runtime-injector/role-id"
    data = {
      role_id = {
        eval_source = "file"
        eval_type   = "string"
        path        = "/openbao/secrets/injector-role-id"
      }
    }
  }

  request "role-injector-secret" {
    operation = "update"
    path      = "auth/approle/role/kodus-runtime-injector/custom-secret-id"
    data = {
      secret_id = {
        eval_source = "file"
        eval_type   = "string"
        path        = "/openbao/secrets/injector-secret-id"
      }
    }
  }
}
