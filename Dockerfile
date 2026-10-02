# Multi-stage: build the Wasm core in one stage, serve static files in the other. The image that
# runs contains no Node, no Rust and no npm packages, only nginx and the files it serves.
#
# The build context is the repository root, so `.dockerignore` keeps node_modules and the cargo
# target directory out of it. They are large and the first one is full of host-specific binaries.

FROM rust:1.90-slim AS build-wasm
WORKDIR /src

# The wasm target and nothing else. The crate has no dependencies, so there is no vendoring step
# and no lock file to go stale between here and the developer's machine.
RUN rustup target add wasm32-unknown-unknown

COPY wasm/Cargo.toml wasm/Cargo.toml
COPY wasm/src wasm/src
RUN cargo build --release --target wasm32-unknown-unknown --manifest-path wasm/Cargo.toml \
    && mkdir -p build \
    && cp wasm/target/wasm32-unknown-unknown/release/fluidmark_core.wasm build/

FROM nginx:1.27-alpine AS serve

# A static site, so nginx's default config is replaced rather than extended: the default serves
# /var/www/html and nothing else, and we are serving from /srv.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY deploy/nginx.conf /etc/nginx/conf.d/fluidmark.conf

COPY www /srv/www
COPY src /srv/src
COPY --from=build-wasm /src/build/fluidmark_core.wasm /srv/build/fluidmark_core.wasm

# The page and its modules come from the same source tree as the Node tools, so they cannot drift
# apart. A copy is deliberate: the running container has no repository and no source of truth of
# its own, and a bind mount would hide exactly the mismatch this is meant to prevent.

EXPOSE 8080

# nginx's own health endpoint, so a container that is up but serving nothing is distinguishable
# from one that is up and working.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]