/**
 * redis.ts — Self-managed Redis for Cal.diy as a Container App.
 *
 * Why not Azure Managed Redis: the new managed product has a $300+/mo
 * floor (smallest Balanced SKU), and Azure Cache for Redis Basic/Standard
 * tiers are no longer provisionable for new deployments. For dev, a
 * Container App running `redis:7-alpine` costs ~$5/mo and is reachable
 * VNet-internally via the Container Apps Environment's internal subdomain.
 *
 * Trade-offs:
 *   - Ephemeral (no persistence): on restart the cache evicts. Cal uses
 *     Redis for session caching and (when enabled) the Trigger.dev queue;
 *     losing the cache on restart is benign — worst case users re-login.
 *   - Single replica: Redis isn't horizontally scalable without clustering.
 *
 * For production swap to Azure Managed Redis with auth + persistence.
 */
import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as app from "@pulumi/azure-native/app/v20240301";

export interface RedisInputs {
  resourceGroup: resources.ResourceGroup;
  envSuffix: string;
  tags: Record<string, string>;
  environment: app.ManagedEnvironment;
  containerAppsEnvDomain: pulumi.Output<string>;
}

export interface RedisOutputs {
  appName: pulumi.Output<string>;
  internalFqdn: pulumi.Output<string>;
  redisUrl: pulumi.Output<string>;
}

export function createRedis(inputs: RedisInputs): RedisOutputs {
  const { resourceGroup, envSuffix, tags, environment, containerAppsEnvDomain } = inputs;

  const appName = `cal-${envSuffix}-redis`;

  new app.ContainerApp(appName, {
    containerAppName: appName,
    resourceGroupName: resourceGroup.name,
    environmentId: environment.id,
    tags,
    configuration: {
      ingress: {
        external: false,
        targetPort: 6379,
        exposedPort: 6379,
        transport: "tcp",
        allowInsecure: true,
      },
    },
    template: {
      containers: [
        {
          name: "redis",
          image: "docker.io/library/redis:7-alpine",
          resources: {
            cpu: 0.25,
            memory: "0.5Gi",
          },
        },
      ],
      scale: {
        minReplicas: 1,
        maxReplicas: 1,
      },
    },
  });

  // Derive the internal FQDN deterministically. Container Apps gives each
  // app a stable name under `<app>.internal.<envDomain>` when ingress is
  // internal-only. We don't read the app's `.latestRevisionFqdn` because
  // that creates a cycle with downstream apps that need the URL at create
  // time (cal-api's env vars).
  const internalFqdn = pulumi.interpolate`${appName}.internal.${containerAppsEnvDomain}`;
  const redisUrl = pulumi.interpolate`redis://${internalFqdn}:6379`;

  return {
    appName: pulumi.output(appName),
    internalFqdn,
    redisUrl,
  };
}
