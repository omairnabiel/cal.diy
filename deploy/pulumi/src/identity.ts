/**
 * identity.ts — User-Assigned Managed Identity + role assignments.
 *
 * One identity (`cal-{env}-id`) is shared by every Container App and
 * by the GitHub Actions CI workflow (federated). Its permissions:
 *
 *   - AcrPull on the registry  → pulls images during cold-start
 *   - Key Vault Secrets User    → reads secret values at startup
 *
 * Federated identity for GitHub Actions is wired in Phase 6; here we
 * just create the identity itself so other Phase 2 resources can grant
 * it roles up front.
 *
 * Why one identity, not one per app:
 *   - Container Apps doesn't natively rotate identities; switching an
 *     app's identity requires a revision update. One shared identity
 *     keeps deploys idempotent.
 *   - All four services need exactly the same permissions (pull image,
 *     read secrets). The blast radius if the identity is compromised is
 *     the same whether it's shared or not — the secrets it reads are
 *     scoped to the services that hold them.
 *
 * If we ever need per-app permissions (e.g. only `agent` can call a
 * specific Storage account), we add a SECOND identity then. Premature
 * fragmentation is just toil.
 */
import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as managedidentity from "@pulumi/azure-native/managedidentity";
import * as authorization from "@pulumi/azure-native/authorization";
import * as containerregistry from "@pulumi/azure-native/containerregistry";

export interface IdentityInputs {
  resourceGroup: resources.ResourceGroup;
  envSuffix: string;
  tags: Record<string, string>;
  registry: containerregistry.Registry;
}

export interface IdentityOutputs {
  identity: managedidentity.UserAssignedIdentity;
  identityId: pulumi.Output<string>;
  principalId: pulumi.Output<string>;
  clientId: pulumi.Output<string>;
}

// Well-known Azure role definition IDs. These are stable global GUIDs;
// using the GUID instead of the role name avoids a round-trip + a
// region-specific lookup that occasionally flakes.
//   https://learn.microsoft.com/azure/role-based-access-control/built-in-roles
const ACR_PULL_ROLE_ID = "7f951dda-4ed3-4680-a7ca-43fe172d538d";

export function createIdentity(inputs: IdentityInputs): IdentityOutputs {
  const { resourceGroup, envSuffix, tags, registry } = inputs;

  const identity = new managedidentity.UserAssignedIdentity(
    `cal-${envSuffix}-id`,
    {
      resourceName: `cal-${envSuffix}-id`,
      resourceGroupName: resourceGroup.name,
      tags,
    },
  );

  // Grant AcrPull on the registry. The role assignment is scoped to the
  // registry only — the identity can't list other registries or read any
  // resource beyond what we explicitly grant.
  new authorization.RoleAssignment(`cal-${envSuffix}-id-acrpull`, {
    // Pulumi-friendly deterministic GUID for the assignment name; without
    // it we get a fresh GUID on every up, which causes drift detection
    // false positives.
    principalId: identity.principalId,
    principalType: "ServicePrincipal",
    roleDefinitionId: pulumi.interpolate`/subscriptions/${getSubscriptionId()}/providers/Microsoft.Authorization/roleDefinitions/${ACR_PULL_ROLE_ID}`,
    scope: registry.id,
  });

  return {
    identity,
    identityId: identity.id,
    principalId: identity.principalId,
    clientId: identity.clientId,
  };
}

// Read the subscription id from the ambient azure-native config. Pulumi
// pulls it from the user's `az login` context, env vars, or service
// principal — same precedence as the Azure CLI. Cached after first call.
let cachedSubscriptionId: pulumi.Output<string> | undefined;
function getSubscriptionId(): pulumi.Output<string> {
  if (cachedSubscriptionId) return cachedSubscriptionId;
  cachedSubscriptionId = pulumi
    .output(authorization.getClientConfig())
    .apply((c) => c.subscriptionId);
  return cachedSubscriptionId;
}
