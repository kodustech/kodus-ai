# Base pinned to the multi-arch index digest so reproducible builds
# can't be invalidated by the upstream tag moving under us. Bump this
# together with the plugin SHA below when cycling RabbitMQ versions.
# rabbitmq:4.2.2-management (linux/amd64,arm64,arm/v7,ppc64le,s390x)
FROM docker.io/library/rabbitmq:4.2.2-management@sha256:ec89397aca0559e8bfe6df98f633ae120abf5301dfb7356fae138aed4c011e89

# Supply-chain pins. Bumping the plugin or rabbitmqadmin version
# requires updating the matching *_SHA256 below.
ARG DELAYED_PLUGIN_VERSION=4.2.0
ARG DELAYED_PLUGIN_SHA256=f168b2c09810cde3726961d31f38e3408e6a7fbff3929908d6f962061d8e70a1
ARG RABBITMQADMIN_REF=v4.2.2
ARG RABBITMQADMIN_SHA256=af0ac0b8126c21aaa289c2438994349ca7a89265ca4777c3ed32bf9833f5d349

# Single RUN layer: install build deps, fetch + verify + install the
# delayed-message plugin and rabbitmqadmin, then drop the tools we
# don't need at runtime. Keeping python3 because rabbitmqadmin is a
# Python script. BuildKit cache mounts reuse apt lists/cache across
# builds instead of re-downloading packages every time.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    set -eux; \
    rm -f /etc/apt/apt.conf.d/docker-clean; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates python3; \
    # Delayed-message exchange plugin — architecture-independent Erlang
    # bytecode, so the same .ez works on every platform we build for.
    curl -fsSL -o /opt/rabbitmq/plugins/rabbitmq_delayed_message_exchange.ez \
      "https://github.com/rabbitmq/rabbitmq-delayed-message-exchange/releases/download/v${DELAYED_PLUGIN_VERSION}/rabbitmq_delayed_message_exchange-${DELAYED_PLUGIN_VERSION}.ez"; \
    echo "${DELAYED_PLUGIN_SHA256}  /opt/rabbitmq/plugins/rabbitmq_delayed_message_exchange.ez" \
      | sha256sum -c -; \
    # rabbitmqadmin CLI for management-API scripting (Python).
    curl -fsSL -o /usr/local/bin/rabbitmqadmin \
      "https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/${RABBITMQADMIN_REF}/deps/rabbitmq_management/bin/rabbitmqadmin"; \
    echo "${RABBITMQADMIN_SHA256}  /usr/local/bin/rabbitmqadmin" \
      | sha256sum -c -; \
    chmod +x /usr/local/bin/rabbitmqadmin; \
    rabbitmq-plugins enable --offline \
      rabbitmq_delayed_message_exchange \
      rabbitmq_management \
      rabbitmq_prometheus; \
    # Drop curl once the downloads are done — keeps the runtime image
    # smaller and reduces attack surface. ca-certificates and python3
    # stay (needed by rabbitmqadmin).
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*

# Provide default configuration artifacts. In production these files will be
# replaced by cloud-init before the container starts so we keep the defaults
# minimal and suitable for local development.
COPY rabbitmq.conf /etc/rabbitmq/rabbitmq.conf

COPY init-definitions.sh /usr/local/bin/init-definitions.sh
RUN chmod +x /usr/local/bin/init-definitions.sh
