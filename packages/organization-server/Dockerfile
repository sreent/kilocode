# Runtime image for the organization server. The binary embeds the admin console, so build it
# first, the same way the CLI's image is built from release binaries:
#
#   bun run --cwd packages/organization-server build
#   docker build -t organization-server packages/organization-server
#
# The image runs as an unprivileged user and keeps its data in the /data volume: the embedded
# Postgres, unless ORGANIZATION_DATABASE_URL points it at a Postgres server.

FROM busybox:1.37 AS data
RUN mkdir -p /data && chown 65532:65532 /data

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=data --chown=65532:65532 /data /data
COPY dist/organization-server /usr/local/bin/organization-server
ENV ORGANIZATION_DATA=/data \
    ORGANIZATION_PORT=8787
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["organization-server"]
CMD ["serve"]
