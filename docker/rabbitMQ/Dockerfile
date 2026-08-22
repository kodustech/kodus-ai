# Base pinned to the multi-arch index digest so reproducible builds
# can't be invalidated by the upstream tag moving under us. Bump this
# together with the plugin SHA below when cycling RabbitMQ versions.
# rabbitmq:4.2.2-management (linux/amd64,arm64,arm/v7,ppc64le,s390x)
FROM docker.io/library/rabbitmq:4.2.2-management@sha256:ec89397aca0559e8bfe6df98f633ae120abf5301dfb7356fae138aed4c011e89

# Supply-chain pin. Bumping the plugin version requires updating the SHA256.
ARG DELAYED_PLUGIN_VERSION=4.2.0
ARG DELAYED_PLUGIN_SHA256=f168b2c09810cde3726961d31f38e3408e6a7fbff3929908d6f962061d8e70a1

# Single RUN layer: install build deps, fetch + verify + install the
# delayed-message plugin, install rabbitmqadmin from the copy the management
# plugin already ships, then drop the tools we don't need at runtime. Keeping
# python3 because that rabbitmqadmin is a Python script. BuildKit cache mounts
# reuse apt lists/cache across builds instead of re-downloading packages.
# sharing=private: builds never need concurrent apt access here, and
# sharing=locked deadlocks the next build if one is killed mid-apt (the
# buildkitd lock stays held). private isolates each build's apt cache.
RUN --mount=type=cache,target=/var/cache/apt,sharing=private \
    --mount=type=cache,target=/var/lib/apt,sharing=private \
    set -eux; \
    rm -f /etc/apt/apt.conf.d/docker-clean; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates python3; \
    # Delayed-message exchange plugin — architecture-independent Erlang
    # bytecode, so the same .ez works on every platform we build for.
    #
    # GitHub throttles by source IP and answers 429/503 in bursts; a bare
    # `curl -f` aborts the whole build on the first one. --retry-all-errors is
    # what makes curl retry an HTTP error at all — plain --retry only covers
    # transport failures and a subset of 5xx. The SHA256 check still gates
    # what actually lands in the image.
    curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors \
      -o /opt/rabbitmq/plugins/rabbitmq_delayed_message_exchange.ez \
      "https://github.com/rabbitmq/rabbitmq-delayed-message-exchange/releases/download/v${DELAYED_PLUGIN_VERSION}/rabbitmq_delayed_message_exchange-${DELAYED_PLUGIN_VERSION}.ez"; \
    echo "${DELAYED_PLUGIN_SHA256}  /opt/rabbitmq/plugins/rabbitmq_delayed_message_exchange.ez" \
      | sha256sum -c -; \
    # rabbitmqadmin CLI for management-API scripting. The management plugin
    # already ships the Python client inside the image, so take it from there
    # instead of fetching it: raw.githubusercontent.com throttles by source IP
    # (429/503) and was failing builds outright. No pin needed — the file comes
    # from the digest-pinned base image, so it is already fixed.
    #
    # This deliberately keeps the Python client at /usr/local/bin, overwriting
    # the rabbitmqadmin v2 binary the base image installs there. Swapping to v2
    # is a real behaviour change for anyone scripting against this image (v1
    # takes -u/-p, v2 takes --username/--password) and belongs in its own
    # change, not in a build fix.
    cp /opt/rabbitmq/plugins/rabbitmq_management-*/priv/www/cli/rabbitmqadmin \
      /usr/local/bin/rabbitmqadmin; \
    chmod +x /usr/local/bin/rabbitmqadmin; \
    rabbitmq-plugins enable --offline \
      rabbitmq_delayed_message_exchange \
      rabbitmq_management \
      rabbitmq_prometheus; \
    # Drop curl once the download is done — keeps the runtime image smaller
    # and reduces attack surface. ca-certificates and python3 stay (python3 is
    # needed by rabbitmqadmin).
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*

# Provide default configuration artifacts. In production these files will be
# replaced by cloud-init before the container starts so we keep the defaults
# minimal and suitable for local development.
COPY rabbitmq.conf /etc/rabbitmq/rabbitmq.conf

COPY init-definitions.sh /usr/local/bin/init-definitions.sh
RUN chmod +x /usr/local/bin/init-definitions.sh
