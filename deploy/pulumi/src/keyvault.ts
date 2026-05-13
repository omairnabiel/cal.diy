/**
 * keyvault.ts — Azure Key Vault for application secrets.
 *
 * Stores all the secret values that Container Apps reference at runtime:
 *   - postgres-admin-password    (generated, never seen by humans)
 *   - livekit-api-key            (from LK Cloud project)
 *   - livekit-api-secret         (from LK Cloud project)
 *   - deepgram-api-key           (from Deepgram dashboard)
 *   - groq-api-key               (from Groq console)
 *   - cartesia-api-key           (from Cartesia dashboard)
 *   - calcom-nextauth-secret     (generated, 32 bytes)
 *   - calcom-encryption-key      (generated, 32 bytes)
 *   - telnyx-api-key             (from Telnyx portal)
 *
 * The identity from identity.ts is granted "Key Vault Secrets User" so
 * each Container App can read the secrets it references — no admin
 * password, no service principal certificate.
 *
 * Naming caveat: Key Vault names must be 3-24 chars, alphanumeric and
 * hyphens, globally unique. Adding a 6-char random suffix avoids the
 * "name in use" failure that bites you when you destroy and re-create.
 * The `@pulumi/random` provider keeps the suffix stable across `up`s.
 */
import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as keyvault from "@pulumi/azure-native/keyvault";
import * as authorization from "@pulumi/azure-native/authorization";
import * as random from "@pulumi/random";

export interface KeyVaultInputs {
  resourceGroup: resources.ResourceGroup;
  envSuffix: string;
  tags: Record<string, string>;
  principalId: pulumi.Output<string>; // managed identity principalId
  tenantId: pulumi.Output<string>;
}

export interface KeyVaultOutputs {
  vault: keyvault.Vault;
  vaultName: pulumi.Output<string>;
  vaultUri: pulumi.Output<string>;
}

const KV_SECRETS_USER_ROLE_ID = "4633458b-17de-408a-b874-0445c86b69e6"; // "Key Vault Secrets User"

export function createKeyVault(inputs: KeyVaultInputs): KeyVaultOutputs {
  const { resourceGroup, envSuffix, tags, principalId, tenantId } = inputs;

  // Random suffix so destroy+recreate doesn't collide with the soft-deleted
  // remnant (Key Vault soft-delete is 7 days minimum; you'd be stuck waiting
  // otherwise). The suffix is stable per stack — Pulumi state preserves it.
  const suffix = new random.RandomString(`cal-${envSuffix}-kv-suffix`, {
    length: 6,
    upper: false,
    special: false,
    numeric: true,
    lower: true,
  });

  const vaultName = pulumi.interpolate`cal-${envSuffix}-kv-${suffix.result}`;

  const vault = new keyvault.Vault(`cal-${envSuffix}-kv`, {
    vaultName,
    resourceGroupName: resourceGroup.name,
    properties: {
      tenantId,
      sku: {
        family: "A",
        name: "standard",
      },
      // RBAC instead of access policies. Access policies are the legacy
      // model; RBAC is what every modern Azure example targets.
      enableRbacAuthorization: true,
      // Soft-delete and purge protection: soft-delete is mandatory in
      // 2026 (Microsoft removed the toggle); purge protection is opt-in
      // and stops accidental hard-deletes during dev. We disable it
      // here because dev environments need to be destroy-able; enable
      // for prod via stack config when you copy this to a prod stack.
      enableSoftDelete: true,
      softDeleteRetentionInDays: 7,
      // Public network access is needed because Container Apps reaches
      // Key Vault over public DNS (no private endpoint here yet). Azure
      // platform IPs are trusted at the auth layer; we don't expose any
      // secrets to anonymous traffic.
      publicNetworkAccess: "Enabled",
      networkAcls: {
        bypass: "AzureServices",
        defaultAction: "Allow",
      },
    },
    tags,
  });

  // Grant the managed identity read access to all secrets in this vault.
  new authorization.RoleAssignment(
    `cal-${envSuffix}-kv-id-secretsuser`,
    {
      principalId,
      principalType: "ServicePrincipal",
      roleDefinitionId: pulumi.interpolate`/subscriptions/${getSubscriptionId()}/providers/Microsoft.Authorization/roleDefinitions/${KV_SECRETS_USER_ROLE_ID}`,
      scope: vault.id,
    },
  );

  return {
    vault,
    vaultName: vault.name,
    vaultUri: pulumi.interpolate`https://${vault.name}.vault.azure.net/`,
  };
}

let cachedSubscriptionId: pulumi.Output<string> | undefined;
function getSubscriptionId(): pulumi.Output<string> {
  if (cachedSubscriptionId) return cachedSubscriptionId;
  cachedSubscriptionId = pulumi
    .output(authorization.getClientConfig())
    .apply((c) => c.subscriptionId);
  return cachedSubscriptionId;
}
