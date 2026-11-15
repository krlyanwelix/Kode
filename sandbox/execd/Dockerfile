# Build execd statically; offer a minimal image and a development image.
ARG BUILDER=golang:1.24-alpine
ARG BASE=alpine:3.20

FROM ${BUILDER} AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/execd .

FROM ${BASE} AS minimal
RUN mkdir -p /opt/execd /workspace
COPY --from=build /out/execd /opt/execd/execd
WORKDIR /workspace
ENV EXECD_ROOT=/workspace
EXPOSE 8765
ENTRYPOINT ["/opt/execd/execd"]

# The agent needs a development environment, while the minimal target stays available.
FROM node:22-bookworm-slim AS development
RUN apt-get update && apt-get install -y --no-install-recommends bash git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /workspace /opt/execd
COPY --from=build /out/execd /opt/execd/execd
WORKDIR /workspace
ENV EXECD_ROOT=/workspace
EXPOSE 8765
ENTRYPOINT ["/opt/execd/execd"]
