/**
 * containerapps.ts — Cal.diy's Container Apps + migrations Job.
 *
 * Two apps + one job:
 *   cal-web      External Next.js. Port 3000. 2.0 CPU / 4Gi (Cal's web
 *                build is heavy; running it under-resourced makes the
 *                first-request compile crawl).
 *   cal-api      NestJS API v2. Internal-only on 5555. cal-web's
 *                /api/v2/* paths forward here.
 *   migrations   Container Apps Job that runs Prisma migrations. Manual
 *                trigger (run via `az containerapp job start` after each
 *                deploy that changes the schema).
 *
 * Image strategy:
 *   Image tags read from `cal:calWebImage` / `cal:calApiImage` Pulumi
 *   config. Default to the MS quickstart placeholder so a first
 *   `pulumi up` succeeds on a fresh stack before CI has ever run.
 *
 * Secrets:
 *   Pulled from Key Vault via the shared managed identity. If a referenced
 *   secret isn't yet in KV (operator hasn't `az keyvault secret set` it),
 *   the env var is silently skipped — the app's own startup config
 *   surfaces missing required env (loud crash > silent misconfig).
 */
import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as app from "@pulumi/azure-native/app/v20240301";
import * as types from "@pulumi/azure-native/types";
import * as managedidentity from "@pulumi/azure-native/managedidentity";
import * as containerregistry from "@pulumi/azure-native/containerregistry";
import * as keyvault from "@pulumi/azure-native/keyvault";

type SecretArgs = types.input.app.v20240301.SecretArgs;
type EnvironmentVarArgs = types.input.app.v20240301.EnvironmentVarArgs;
type IngressArgs = types.input.app.v20240301.IngressArgs;
type JobSecretArgs = types.input.app.v20240301.SecretArgs;

const PLACEHOLDER_IMAGE = "mcr.microsoft.com/k8se/quickstart:latest";

// Default RESERVED_SUBDOMAINS from Cal's .env.example. Cal validates
// usernames against this list at signup.
const RESERVED_SUBDOMAINS = JSON.stringify([
  "app", "auth", "docs", "design", "console", "go", "status", "api", "saml",
  "www", "matrix", "developer", "cal", "my", "team", "support", "security",
  "blog", "learn", "admin",
]);

export interface ContainerAppsInputs {
  resourceGroup: resources.ResourceGroup;
  envSuffix: string;
  tags: Record<string, string>;
  environment: app.ManagedEnvironment;
  registry: containerregistry.Registry;
  identity: managedidentity.UserAssignedIdentity;
  vault: keyvault.Vault;
  availableSecretNames: pulumi.Input<string[]>;
}

export interface ContainerAppsOutputs {
  calWebFqdn: pulumi.Output<string>;
  calApiFqdn: pulumi.Output<string>;
  calMigrationsJobName: pulumi.Output<string>;
}

function buildSharedSecrets(args: {
  vault: keyvault.Vault;
  identity: managedidentity.UserAssignedIdentity;
  availableNames: pulumi.Input<string[]>;
}): pulumi.Output<SecretArgs[]> {
  return pulumi
    .all([args.availableNames, args.vault.name, args.identity.id])
    .apply(([names, vaultName, identityId]) =>
      names.map((name) => ({
        name,
        keyVaultUrl: `https://${vaultName}.vault.azure.net/secrets/${name}`,
        identity: identityId,
      })),
    );
}

function buildEnv(args: {
  plain: Array<[string, pulumi.Input<string>]>;
  fromSecret: Array<[string, string]>;
  availableNames: pulumi.Input<string[]>;
}): pulumi.Output<EnvironmentVarArgs[]> {
  const plainValues = args.plain.map(([, v]) => v);
  return pulumi
    .all([pulumi.output(args.availableNames), pulumi.all(plainValues)])
    .apply(([names, resolved]) => {
      const available = new Set(names);
      const out: EnvironmentVarArgs[] = [];
      args.plain.forEach(([name], i) => {
        out.push({ name, value: resolved[i] });
      });
      for (const [envName, secretName] of args.fromSecret) {
        if (!available.has(secretName)) {
          pulumi.log.info(
            `Skipping env var ${envName}: secret "${secretName}" not yet in Key Vault.`,
          );
          continue;
        }
        out.push({ name: envName, secretRef: secretName });
      }
      return out;
    });
}

export function createContainerApps(
  inputs: ContainerAppsInputs,
): ContainerAppsOutputs {
  const {
    resourceGroup,
    envSuffix,
    tags,
    environment,
    registry,
    identity,
    vault,
    availableSecretNames,
  } = inputs;

  const config = new pulumi.Config("cal");
  const calWebImage = config.get("calWebImage") ?? PLACEHOLDER_IMAGE;
  const calApiImage = config.get("calApiImage") ?? PLACEHOLDER_IMAGE;
  // Comma-separated FQDNs from external consumers (e.g. Wavey's admin-ui
  // and backend) that Cal should accept in its host-allowlist check.
  // Set via:
  //   pulumi config set cal:additionalAllowedHostnames "wavey-...,wavey-..."
  // Hostnames only — no scheme. Cal checks the request `Host` header.
  const additionalAllowedHostnames = (config.get("additionalAllowedHostnames") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const sharedSecrets = buildSharedSecrets({
    vault,
    identity,
    availableNames: availableSecretNames,
  });

  // Deterministic FQDNs (computed from app name + env domain). Avoids
  // chicken-and-egg between cal-web and cal-api wanting each other's URL.
  //
  // Both apps have external ingress. cal-api lives in a different VNet
  // from Wavey, so Wavey's backend has no internal path to it — it must
  // reach cal-api over the public network with API-key auth. That's the
  // same shape you'd integrate Cal.com Cloud, so we mirror it here.
  const calWebAppName = `cal-${envSuffix}-cal-web`;
  const calApiAppName = `cal-${envSuffix}-cal-api`;
  const calWebFqdn = pulumi.interpolate`${calWebAppName}.${environment.defaultDomain}`;
  const calApiFqdn = pulumi.interpolate`${calApiAppName}.${environment.defaultDomain}`;
  const calWebPublicUrl = pulumi.interpolate`https://${calWebFqdn}`;
  const calApiPublicUrl = pulumi.interpolate`https://${calApiFqdn}`;

  const calWebIngress: IngressArgs = {
    external: true,
    targetPort: 3000,
    transport: "auto",
    allowInsecure: false,
    traffic: [{ weight: 100, latestRevision: true }],
  };

  const calApiIngress: IngressArgs = {
    external: true,
    targetPort: 5555,
    transport: "auto",
    allowInsecure: false,
    traffic: [{ weight: 100, latestRevision: true }],
  };

  // ─── cal-web ──────────────────────────────────────────────────────────
  new app.ContainerApp(calWebAppName, {
    containerAppName: calWebAppName,
    resourceGroupName: resourceGroup.name,
    environmentId: environment.id,
    identity: {
      type: "UserAssigned",
      userAssignedIdentities: [identity.id],
    },
    configuration: {
      activeRevisionsMode: "Single",
      ingress: calWebIngress,
      registries: [
        { server: registry.loginServer, identity: identity.id },
      ],
      secrets: sharedSecrets,
    },
    template: {
      containers: [
        {
          name: calWebAppName,
          image: calWebImage,
          resources: { cpu: 2.0, memory: "4Gi" },
          env: buildEnv({
            plain: [
              ["NODE_ENV", "production"],
              ["CALCOM_TELEMETRY_DISABLED", "1"],
              ["EMAIL_FROM", "no-reply@bitsandbytes.to"],
              ["EMAIL_FROM_NAME", "Cal.diy"],
              ["NEXT_PUBLIC_WEBAPP_URL", calWebPublicUrl],
              ["NEXT_PUBLIC_WEBSITE_URL", calWebPublicUrl],
              ["NEXTAUTH_URL", calWebPublicUrl],
              ["NEXT_PUBLIC_API_V2_URL", pulumi.interpolate`${calApiPublicUrl}/v2`],
              [
                "ALLOWED_HOSTNAMES",
                // Cal's parser expects a comma-separated list of
                // quoted hostnames (matches the .env.example shape).
                calWebFqdn.apply((fqdn) =>
                  [`"${fqdn}"`, ...additionalAllowedHostnames.map((h) => `"${h}"`)].join(","),
                ),
              ],
              ["RESERVED_SUBDOMAINS", RESERVED_SUBDOMAINS],
            ],
            fromSecret: [
              ["NEXTAUTH_SECRET", "cal-nextauth-secret"],
              ["CALENDSO_ENCRYPTION_KEY", "cal-encryption-key"],
              ["CALCOM_SERVICE_ACCOUNT_ENCRYPTION_KEY", "cal-service-account-encryption-key"],
              ["CAL_VIDEO_RECORDING_TOKEN_SECRET", "cal-video-recording-token-secret"],
              ["RESEND_API_KEY", "resend-api-key"],
              ["GOOGLE_API_CREDENTIALS", "google-api-credentials"],
              ["DATABASE_URL", "cal-database-url"],
              ["DATABASE_DIRECT_URL", "cal-database-url"],
            ],
            availableNames: availableSecretNames,
          }),
        },
      ],
      scale: { minReplicas: 1, maxReplicas: 1 },
    },
    tags,
  });

  // ─── cal-api ──────────────────────────────────────────────────────────
  new app.ContainerApp(calApiAppName, {
    containerAppName: calApiAppName,
    resourceGroupName: resourceGroup.name,
    environmentId: environment.id,
    identity: {
      type: "UserAssigned",
      userAssignedIdentities: [identity.id],
    },
    configuration: {
      activeRevisionsMode: "Single",
      ingress: calApiIngress,
      registries: [
        { server: registry.loginServer, identity: identity.id },
      ],
      secrets: sharedSecrets,
    },
    template: {
      // Two containers in this Container App: the NestJS API, and a
      // Redis sidecar. They share localhost, so REDIS_URL just points
      // at localhost:6379. This works around the Container Apps Consumption-
      // plan limitation where inter-app internal TCP ingress times out.
      containers: [
        {
          name: calApiAppName,
          image: calApiImage,
          resources: { cpu: 1.0, memory: "2Gi" },
          env: buildEnv({
            plain: [
              ["NODE_ENV", "production"],
              ["API_PORT", "5555"],
              ["API_URL", "http://localhost"],
              ["LOG_LEVEL", "INFO"],
              ["WEB_APP_URL", pulumi.interpolate`${calWebPublicUrl}/`],
              ["API_KEY_PREFIX", "cal_"],
              ["IS_E2E", "false"],
              ["LOGGER_BRIDGE_LOG_LEVEL", "1"],
              ["REWRITE_API_V2_PREFIX", "1"],
              ["ENABLE_ASYNC_TASKER", "false"],
            ],
            fromSecret: [
              ["NEXTAUTH_SECRET", "cal-nextauth-secret"],
              ["CALENDSO_ENCRYPTION_KEY", "cal-encryption-key"],
              ["CALCOM_SERVICE_ACCOUNT_ENCRYPTION_KEY", "cal-service-account-encryption-key"],
              ["CAL_VIDEO_RECORDING_TOKEN_SECRET", "cal-video-recording-token-secret"],
              ["GOOGLE_API_CREDENTIALS", "google-api-credentials"],
              ["JWT_SECRET", "cal-jwt-secret"],
              ["STRIPE_API_KEY", "cal-stripe-api-key"],
              ["STRIPE_WEBHOOK_SECRET", "cal-stripe-webhook-secret"],
              ["REDIS_URL", "cal-redis-url"],
              ["DATABASE_URL", "cal-database-url"],
              ["DATABASE_DIRECT_URL", "cal-database-url"],
              ["DATABASE_READ_URL", "cal-database-url"],
              ["DATABASE_WRITE_URL", "cal-database-url"],
            ],
            availableNames: availableSecretNames,
          }),
        },
        {
          name: "redis",
          image: "docker.io/library/redis:7-alpine",
          resources: { cpu: 0.25, memory: "0.5Gi" },
          // Bind to localhost only — no external exposure. Ephemeral
          // (no persistence volume); cache evicts on revision roll.
          command: ["redis-server", "--bind", "127.0.0.1", "--port", "6379"],
        },
      ],
      scale: { minReplicas: 1, maxReplicas: 1 },
    },
    tags,
  });

  // ─── migrations Job ───────────────────────────────────────────────────
  // Manual-trigger Container Apps Job. Runs `prisma migrate deploy`
  // against the calendso DB. Trigger with:
  //   az containerapp job start --name $(pulumi stack output calMigrationsJobName) \
  //                              --resource-group cal-dev-rg
  const migrationsJobName = `cal-${envSuffix}-migrations`;
  const migrationsJob = new app.Job(migrationsJobName, {
    jobName: migrationsJobName,
    resourceGroupName: resourceGroup.name,
    environmentId: environment.id,
    identity: {
      type: "UserAssigned",
      userAssignedIdentities: [identity.id],
    },
    configuration: {
      triggerType: "Manual",
      replicaTimeout: 1800,
      replicaRetryLimit: 1,
      manualTriggerConfig: {
        replicaCompletionCount: 1,
        parallelism: 1,
      },
      registries: [
        { server: registry.loginServer, identity: identity.id },
      ],
      secrets: sharedSecrets as pulumi.Output<JobSecretArgs[]>,
    },
    template: {
      containers: [
        {
          name: "migrations",
          // Same image as cal-api (it has the prisma deps + schema).
          image: calApiImage,
          resources: { cpu: 0.5, memory: "1Gi" },
          // `sh -c` avoids the exec parser splitting `@calcom/...`.
          command: ["sh", "-c"],
          args: ["yarn workspace @calcom/prisma db-deploy"],
          env: buildEnv({
            plain: [
              ["NODE_ENV", "production"],
            ],
            fromSecret: [
              ["DATABASE_URL", "cal-database-url"],
              ["DATABASE_DIRECT_URL", "cal-database-url"],
            ],
            availableNames: availableSecretNames,
          }),
        },
      ],
    },
    tags,
  });

  return {
    calWebFqdn,
    calApiFqdn,
    calMigrationsJobName: migrationsJob.name,
  };
}
