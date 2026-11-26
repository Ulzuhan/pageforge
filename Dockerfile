# One Dockerfile, two images: --build-arg TOOL=pageforge or TOOL=inkbar.
# React is built with Node; the image ships only the Go binary with the
# interface embedded. No Node, npm or browser in the runtime.
ARG TOOL=pageforge

FROM node:22-alpine AS assets
ARG TOOL
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package*.json ./
# Not --omit=dev: vite and its chain are dev dependencies, and without them there is nothing to build.
RUN npm ci
COPY vite.config.mts tsconfig.json ./
COPY scripts/copy-pdfjs-assets.mjs ./scripts/
COPY apps ./apps
COPY packages ./packages
RUN node scripts/copy-pdfjs-assets.mjs && npx vite build --config vite.config.mts --mode "$TOOL"

FROM golang:1.27.3-alpine AS build
ARG TOOL
WORKDIR /src
# Standard library only: no go.sum to verify and nothing to download. If a
# dependency ever comes in, this stage starts needing the network; look at it then.
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
# The interface comes from the previous stage, never from the host:
# internal/web/*/dist is in .dockerignore so a local build cannot slip in.
COPY --from=assets /app/internal/web/${TOOL}/dist ./internal/web/${TOOL}/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/tool ./cmd/${TOOL}

FROM alpine:3.24 AS runtime
ARG TOOL
# Stateless: no data directory. The image runs with a read-only root filesystem.
RUN apk -U upgrade --no-cache && addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
COPY --from=build /out/tool /usr/local/bin/tool
USER 10001
ENV HOSTNAME=0.0.0.0
# 3468 for PageForge, 3469 for InkBar (set by the binary; PORT overrides).
EXPOSE 3468 3469
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["tool", "health"]
ENTRYPOINT ["tool"]
