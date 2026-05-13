/**
 * registry.ts — Azure Container Registry (ACR).
 *
 * One ACR per environment holds the two Cal.diy service images:
 *   - caldevacr.azurecr.io/cal-web:<sha>
 *   - caldevacr.azurecr.io/cal-api:<sha>
 *
 * Auth model:
 *   - Container Apps pulls using the user-assigned managed identity from
 *     identity.ts — no admin password persisted anywhere.
 *   - GitHub Actions pushes using a federated credential on the same
 *     identity (set up in Phase 6). No long-lived service principal.
 *
 * SKU choice:
 *   `Basic` — $5/mo, 10 GB storage, 2 webhooks. Fine for dev and a
 *   small team. Upgrade to `Standard` ($20/mo, 100 GB, geo-replication
 *   capable) for production if image storage outgrows it.
 */
import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as containerregistry from "@pulumi/azure-native/containerregistry";

export interface RegistryInputs {
  resourceGroup: resources.ResourceGroup;
  envSuffix: string;
  tags: Record<string, string>;
}

export interface RegistryOutputs {
  registry: containerregistry.Registry;
  loginServer: pulumi.Output<string>; // e.g. caldevacr.azurecr.io
  name: pulumi.Output<string>;
}

export function createRegistry(inputs: RegistryInputs): RegistryOutputs {
  const { resourceGroup, envSuffix, tags } = inputs;

  // ACR names must be 5-50 chars, lowercase alphanumeric only, globally
  // unique across all of Azure. `cal{env}acr` is short enough to avoid
  // collisions for an `{env}` like `dev` or `prod`, but if you ever hit a
  // collision Pulumi will fail with a clear error — add a `random.RandomString`
  // suffix at that point. We don't add randomness pre-emptively because
  // stable names make CI debugging easier.
  const registryName = `cal${envSuffix}acr`;

  const registry = new containerregistry.Registry(registryName, {
    registryName,
    resourceGroupName: resourceGroup.name,
    sku: {
      name: "Basic",
    },
    // Disable admin user — we use the managed identity exclusively. This
    // closes a common credential-leak vector (basic auth in pipelines).
    adminUserEnabled: false,
    // Public network access is enabled (default) so GitHub Actions can
    // push to it without a self-hosted runner inside the VNet. ACR's
    // built-in Azure AD auth + scoped tokens make this safe — we never
    // accept anonymous pulls or pushes.
    publicNetworkAccess: "Enabled",
    tags,
  });

  return {
    registry,
    loginServer: registry.loginServer,
    name: registry.name,
  };
}
