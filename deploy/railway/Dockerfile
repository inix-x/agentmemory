ARG III_VERSION=0.11.2

FROM iiidev/iii:${III_VERSION} AS iii-image

# Build the package from this repo rather than pulling it from the registry, so
# fixes that live on a fork actually reach the deployed container. `npm pack`
# produces the same tarball shape the registry would serve, which keeps the
# install layout below identical to the previous registry install.
FROM node:22-slim AS builder
WORKDIR /build
# No lockfile: .gitignore:23 excludes it by repo policy, so it is absent from
# any git-based build context and `npm ci` cannot run. This trades build
# reproducibility away, which is the policy's cost, not a choice made here.
COPY package.json ./
# node:22-slim ships npm 10.9.x, whose arborist fails this dependency tree with
# "Cannot read properties of null (reading 'edgesOut')" when resolving without a
# lockfile. Reproduced on a clean git-only context; npm 11 resolves it cleanly.
RUN npm install -g npm@11.19.0 --no-fund --no-audit \
 && npm install --no-fund --no-audit
COPY . .
# npm pack does not create --pack-destination, so make it first.
RUN mkdir -p /out \
 && npm run build \
 && npm pack --pack-destination /out

FROM node:22-slim

ARG III_VERSION=0.11.2
ARG III_SDK_VERSION=0.11.2

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini gosu curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=iii-image /app/iii /usr/local/bin/iii

# Install into a dedicated prefix. The path below is load-bearing: entrypoint.sh
# writes the iii worker config to
# /opt/agentmemory/node_modules/@agentmemory/agentmemory/dist/iii-config.yaml
# under `set -eu`, so moving this prefix kills the container at boot rather than
# at build time. Installing the packed tarball keeps npm placing the package at
# node_modules/<pkg-name>/, which reproduces that exact path.
WORKDIR /opt/agentmemory
COPY --from=builder /out/*.tgz /tmp/agentmemory.tgz
# The runtime install resolves the tarball's dependencies against the registry,
# so the repo's `overrides` never reach it on their own. These are CVE pins
# (added by 91c78e7, "clear all 8 audit vulns"). Read them out of the packed
# tarball rather than retyping them, so a new pin in package.json cannot ship
# unpinned here without anyone noticing.
RUN OVERRIDES="$(tar -xzOf /tmp/agentmemory.tgz package/package.json | node -p 'JSON.stringify((JSON.parse(require("fs").readFileSync(0,"utf8")).overrides)||{})')" \
 && printf '{"name":"agentmemory-deploy","version":"1.0.0","private":true,"overrides":%s}\n' "$OVERRIDES" > package.json \
 && npm install /tmp/agentmemory.tgz --omit=optional --no-fund --no-audit \
 && rm -f /tmp/agentmemory.tgz \
 && ln -s /opt/agentmemory/node_modules/.bin/agentmemory /usr/local/bin/agentmemory

# The previous Dockerfile pinned iii-sdk through an `overrides` block to stop a
# caret range resolving past the engine. Both this repo and the published package
# now pin iii-sdk exactly, so the override is redundant. Assert the resolved
# version instead of carrying a workaround for a condition that may not hold: a
# mismatch fails the build here rather than at runtime in production.
RUN RESOLVED="$(node -p "require('/opt/agentmemory/node_modules/iii-sdk/package.json').version")" \
 && echo "resolved iii-sdk: ${RESOLVED} (expected ${III_SDK_VERSION})" \
 && [ "${RESOLVED}" = "${III_SDK_VERSION}" ]

# Prove the build produced a usable install at the path the entrypoint expects.
# Without this the image can ship a broken layout that only fails at boot, where
# failure costs a restart-budget entry instead of a build.
RUN test -f /opt/agentmemory/node_modules/@agentmemory/agentmemory/dist/iii-config.yaml \
 && test -x /usr/local/bin/agentmemory

ENV AGENTMEMORY_III_VERSION=${III_VERSION} \
    TINI_SUBREAPER=1

COPY --chmod=0755 deploy/railway/entrypoint.sh /usr/local/bin/agentmemory-entrypoint.sh

EXPOSE 3111

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agentmemory-entrypoint.sh"]
