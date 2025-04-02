FROM postgres:latest
RUN apt-get update && apt-get install -y git build-essential postgresql-server-dev-$(pg_config --version | sed 's/[^0-9]*\([0-9]*\).*/\1/') \
    && cd /tmp \
    && rm -rf pgvector || true \
    && git clone --branch v0.5.1 https://github.com/pgvector/pgvector.git \
    && cd pgvector \
    && make \
    && make install