# Base pinned to the multi-arch index digest so reproducible builds
# can't be invalidated by the upstream tag moving under us. Bump this
# when cycling RabbitMQ versions.
# rabbitmq:4.3.6-management (linux/amd64,arm64,arm/v7,ppc64le,s390x)
FROM docker.io/library/rabbitmq:4.3.6-management@sha256:316ffd2a847e59112eee2c65f04bbd0989d93aaf1486c07b721f8d22d863b968

# No delayed-message plugin: it is unmaintained and cannot run on RabbitMQ
# >= 4.3 (#1663). Kodus delays retries with TTL wait queues instead
# (libs/core/infrastructure/queue/config/rabbitmq-retry-topology.ts).

# The base image already ships rabbitmqadmin v2 (/usr/local/bin). 4.3 no
# longer bundles the v1 Python client this image used to copy over it; nothing
# in this image calls rabbitmqadmin (init-definitions.sh uses rabbitmqctl).
RUN rabbitmq-plugins enable --offline rabbitmq_management rabbitmq_prometheus

# Provide default configuration artifacts. In production these files will be
# replaced by cloud-init before the container starts so we keep the defaults
# minimal and suitable for local development.
COPY rabbitmq.conf /etc/rabbitmq/rabbitmq.conf

COPY init-definitions.sh /usr/local/bin/init-definitions.sh
RUN chmod +x /usr/local/bin/init-definitions.sh
