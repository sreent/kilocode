# Deploying the organization server

Ready-made deployments for Kubernetes and three managed container platforms. Each runs the server's container image, which you build ([Docker](../README.md#docker)) and push to a registry the platform can pull from.

| Platform | Files | Database |
|---|---|---|
| Kubernetes | [`helm/organization-server`](helm/organization-server) | Embedded on a persistent volume (one replica), or a PostgreSQL server (any number) |
| AWS ECS on Fargate | [`aws-ecs`](aws-ecs) | Amazon RDS or Aurora PostgreSQL |
| Google Cloud Run | [`gcp-cloud-run`](gcp-cloud-run) | Cloud SQL for PostgreSQL |
| Azure Container Apps | [`azure-container-apps`](azure-container-apps) | Azure Database for PostgreSQL |

Replace the placeholders in them (account and project ids, regions, image, domain, secret names) with your own.

## What every deployment needs

- **A public HTTPS URL**, in `ORGANIZATION_BASE_URL`, the same on every instance.
- **`ORGANIZATION_SECRET`**, from the platform's secret store, the same on every instance, and kept: what it seals can't be read without it. `openssl rand -hex 32` makes one.
- **A PostgreSQL server** in `ORGANIZATION_DATABASE_URL` on the managed platforms, whose instances keep nothing on disk between restarts. The embedded database needs one instance and a persistent volume, which only the Helm chart sets up.
- **The first organization.** `ORGANIZATION_BOOTSTRAP_ORG`, `ORGANIZATION_BOOTSTRAP_SLUG` and `ORGANIZATION_BOOTSTRAP_EMAIL` name it, and the server creates it the first time it starts on an empty database. Its owner signs in at `/admin` with `ORGANIZATION_BOOTSTRAP_TOKEN`, which you choose: `korg_$(openssl rand -hex 32)`. Once single sign-on works, revoke that token and remove the variables.
- **One instance always running, with CPU between requests.** Audit streams, scheduled reports and model price updates run in the background, and so do backups with the embedded database.
- **Long requests.** LLM gateway calls stream for minutes. Raise the load balancer's idle timeout to an hour where it allows it.
- **Health checks from outside.** The image has no shell, so checks are HTTP: `GET /healthz` while the process runs, and `GET /readyz` while its database answers too.
- **The proxy count**, in `ORGANIZATION_TRUST_PROXY`: how many proxies in front of the server append the address they saw to `X-Forwarded-For`. Audit entries and rate limits read the client's address that many entries from the end.

To check the proxy count once the server runs, make a change the audit log records with a made-up address in the header, then look at the address the log shows for it:

```sh
curl -X POST https://ai.example.com/api/v1/orgs/example/groups \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "X-Forwarded-For: 192.0.2.1" -d '{"name":"Proxy check"}'
```

Your own address means the count is right. `192.0.2.1` means it is too high, and a load balancer's address that it is too low. Delete the group afterwards.

## Kubernetes

```sh
kubectl create secret generic tucode-organization \
  --from-literal=ORGANIZATION_SECRET=$(openssl rand -hex 32) \
  --from-literal=ORGANIZATION_BOOTSTRAP_TOKEN=korg_$(openssl rand -hex 32)

helm install tucode ./helm/organization-server \
  --set image.repository=registry.example.com/organization-server \
  --set baseUrl=https://ai.example.com \
  --set secret.existingSecret=tucode-organization \
  --set bootstrap.org=Example,bootstrap.slug=example,bootstrap.email=admin@example.com \
  --set bootstrap.existingSecret=tucode-organization \
  --set ingress.enabled=true,ingress.className=nginx
```

[`values.yaml`](helm/organization-server/values.yaml) describes every setting.

- Without `database.url` or `database.existingSecret`, the server keeps its data in the embedded database on a persistent volume. It runs one replica, and an upgrade stops it before starting the new one. It backs the database up into `backups/` on the same volume; copy those elsewhere, or snapshot the volume.
- With a PostgreSQL server, it runs `replicaCount` replicas, upgrades them one at a time, and keeps one running through node drains.
- Pods run as a non-root user with a read-only root file system and no service account token.
- The ingress annotations let gateway streams through ingress-nginx unbuffered for up to an hour. Other controllers need their own equivalents. `trustProxy` is 1 for the ingress controller; add one if a cloud load balancer in front of it appends to `X-Forwarded-For` too.

## AWS ECS on Fargate

1. Keep the secrets in one Secrets Manager secret, with the keys `ORGANIZATION_SECRET`, `ORGANIZATION_DATABASE_URL` and `ORGANIZATION_BOOTSTRAP_TOKEN`. The task execution role needs `secretsmanager:GetSecretValue` on it (and `kms:Decrypt` if a customer managed key encrypts it), besides the `AmazonECSTaskExecutionRolePolicy` permissions for the image and logs. Create the `/ecs/tucode-organization-server` log group.
2. For RDS, the URL is `postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=verify-full&sslrootcert=/certs/rds-global-bundle.pem`, with [Amazon's certificate bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html) added to the image (`COPY global-bundle.pem /certs/rds-global-bundle.pem` in a Dockerfile `FROM` yours). `uselibpqcompat=true&sslmode=require` instead encrypts the connection without checking the server's certificate.
3. Put an Application Load Balancer in front, with an HTTPS listener and a target group of type `ip` on port 8787, health check path `/readyz`. Lower the target group's deregistration delay to 120 seconds, and raise the load balancer's idle timeout to an hour:

   ```sh
   aws elbv2 modify-load-balancer-attributes --load-balancer-arn $ALB \
     --attributes Key=idle_timeout.timeout_seconds,Value=3600
   ```

4. Register the task definition and create the service:

   ```sh
   aws ecs register-task-definition --cli-input-json file://aws-ecs/task-definition.json
   aws ecs create-service --cli-input-json file://aws-ecs/service.json
   ```

The load balancer appends the client's address to `X-Forwarded-For`, so `ORGANIZATION_TRUST_PROXY` is 1. Add one for CloudFront in front of it.

## Google Cloud Run

1. Keep the secrets in Secret Manager as `tucode-organization-secret`, `tucode-organization-database-url` and `tucode-organization-bootstrap-token`. The service's account needs `roles/secretmanager.secretAccessor` on them and `roles/cloudsql.client`.
2. Point the URL at the Cloud SQL instance's socket, which Cloud Run connects and encrypts: `postgres://USER:PASSWORD@/DATABASE?host=/cloudsql/PROJECT:REGION:INSTANCE`.
3. Deploy, let anyone reach the service (the server signs people in itself), and map your domain to it:

   ```sh
   gcloud run services replace gcp-cloud-run/service.yaml --region us-central1
   gcloud run services add-iam-policy-binding tucode-organization-server --region us-central1 \
     --member=allUsers --role=roles/run.invoker
   ```

One instance always runs with its CPU allocated, which is billed while it runs. Requests may take up to an hour, Cloud Run's longest. Each instance opens up to `ORGANIZATION_DATABASE_POOL` connections, so keep `maxScale` times that under the database's connection limit. `ORGANIZATION_TRUST_PROXY` is 1 on Cloud Run's own address. Behind an external Application Load Balancer it is 2, since that load balancer appends the client's address and then its own.

## Azure Container Apps

1. Create a user-assigned managed identity with `AcrPull` on the registry and `Key Vault Secrets User` on a vault holding `organization-secret`, `database-url` and `bootstrap-token`.
2. For Azure Database for PostgreSQL, the URL is `postgres://USER:PASSWORD@SERVER.postgres.database.azure.com:5432/DATABASE?sslmode=verify-full`.
3. Create the app, then add your domain and its certificate:

   ```sh
   az containerapp create --resource-group tucode --name tucode-organization-server \
     --yaml azure-container-apps/containerapp.yaml
   ```

The environment's ingress closes a request that sends nothing for 4 minutes. A gateway stream that pauses for longer needs [premium ingress](https://learn.microsoft.com/azure/container-apps/premium-ingress), which allows up to 30 minutes on an environment with a workload profile of at least two nodes:

```sh
az containerapp env premium-ingress add --resource-group tucode --name tucode \
  --workload-profile-name Ingress-D4 --request-idle-timeout 30
```

`ORGANIZATION_TRUST_PROXY` is 1 for the environment's ingress. Add one for each proxy in front of it, such as Front Door or Application Gateway.
