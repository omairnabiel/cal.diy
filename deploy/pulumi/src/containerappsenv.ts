/**
 * containerappsenv.ts — Container Apps Managed Environment.
 *
 * One environment per stack hosts all four Container Apps (backend,
 * agent, admin-ui, calcom). The environment is the network + observability
 * boundary — apps inside it can reach each other by app name on the
 * internal hostname (e.g. `https://backend.internal.<env-dns-suffix>`).
 *
 * Workload profile: we use the Consumption profile only. It scales to
 * zero when idle, billed per vCPU-second. Suitable for everything we run
 * because all four services are HTTP/outbound — none of them needs a
 * dedicated VM behind it.
 *
 * Network: attached to the Container Apps subnet from network.ts. With
 * `internal=false` the environment exposes a public ingress URL per
 * app (great for dev). Switch to `internal=true` for prod and add a
 * Front Door in front; that's a Phase 6 prod-only concern.
 *
 * Observability: Log Analytics workspace stamped automatically so
 * `az containerapp logs show` and the Azure portal log streams work
 * without extra plumbing.
 */
import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
// Use the v20240301 (GA) API version explicitly. The default
// `@pulumi/azure-native/app` import currently resolves to an older shape
// of WorkloadProfileArgs that lacks `name` — pinning to v20240301 picks
// the modern shape that matches what `az containerapp env create` writes.
// Bumping this version is a deliberate decision; don't auto-track latest.
import * as app from "@pulumi/azure-native/app/v20240301";
import * as operationalinsights from "@pulumi/azure-native/operationalinsights";
import * as network from "@pulumi/azure-native/network";

export interface ContainerAppsEnvInputs {
  resourceGroup: resources.ResourceGroup;
  envSuffix: string;
  tags: Record<string, string>;
  containerAppsSubnet: network.Subnet;
}

export interface ContainerAppsEnvOutputs {
  environment: app.ManagedEnvironment;
  environmentId: pulumi.Output<string>;
  defaultDomain: pulumi.Output<string>;
  logWorkspace: operationalinsights.Workspace;
}

export function createContainerAppsEnv(
  inputs: ContainerAppsEnvInputs,
): ContainerAppsEnvOutputs {
  const { resourceGroup, envSuffix, tags, containerAppsSubnet } = inputs;

  // Log Analytics workspace — required for Container Apps logging.
  // 30-day retention is the free default; bump for prod if you want
  // longer audit windows (paid past 31 days).
  const logWorkspace = new operationalinsights.Workspace(
    `cal-${envSuffix}-logs`,
    {
      workspaceName: `cal-${envSuffix}-logs`,
      resourceGroupName: resourceGroup.name,
      sku: { name: "PerGB2018" }, // pay-as-you-go, ~$2.30/GB ingested
      retentionInDays: 30,
      tags,
    },
  );

  // SharedKey is the wire-secret Container Apps uses to write logs.
  // azure-native exposes it via the listKeys API. We pulumi.secret it
  // so it never leaks into preview output.
  const logSharedKey = pulumi
    .all([resourceGroup.name, logWorkspace.name])
    .apply(([rg, ws]) =>
      operationalinsights.getSharedKeys({
        resourceGroupName: rg,
        workspaceName: ws,
      }),
    )
    .apply((r) => pulumi.secret(r.primarySharedKey ?? ""));

  const environment = new app.ManagedEnvironment(`cal-${envSuffix}-cae`, {
    environmentName: `cal-${envSuffix}-cae`,
    resourceGroupName: resourceGroup.name,
    appLogsConfiguration: {
      destination: "log-analytics",
      logAnalyticsConfiguration: {
        customerId: logWorkspace.customerId,
        sharedKey: logSharedKey,
      },
    },
    vnetConfiguration: {
      // `infrastructureSubnetId` is the new shape (replaces the older
      // `runtimeSubnetId`/`platformReservedCidr` combo). For the
      // Consumption-only profile this is the only subnet ref needed.
      infrastructureSubnetId: containerAppsSubnet.id,
      // internal=false → public ingress per app (dev-friendly). Flip for prod.
      internal: false,
    },
    // Consumption-only workload profile = no dedicated VMs, true
    // scale-to-zero, pay-per-request. The platform name "Consumption"
    // is mandatory; you don't pick a SKU here.
    workloadProfiles: [
      {
        name: "Consumption",
        workloadProfileType: "Consumption",
      },
    ],
    tags,
  });

  return {
    environment,
    environmentId: environment.id,
    defaultDomain: environment.defaultDomain,
    logWorkspace,
  };
}
