# Runtime image for the enterprise control plane. The binary embeds the admin console, so build it
# first, the same way the CLI's image is built from release binaries:
#
#   bun run --cwd packages/enterprise-server build
#   docker build -t enterprise-server packages/enterprise-server
#
# The image runs as an unprivileged user and keeps its SQLite database in the /data volume.

FROM busybox:1.37 AS data
RUN mkdir -p /data && chown 65532:65532 /data

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=data --chown=65532:65532 /data /data
COPY dist/enterprise-server /usr/local/bin/enterprise-server
ENV ENTERPRISE_DB=/data/enterprise.db \
    ENTERPRISE_PORT=8787
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["enterprise-server"]
CMD ["serve"]
