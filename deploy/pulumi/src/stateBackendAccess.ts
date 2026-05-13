/**
 * stateBackendAccess.ts — grant the CI managed identity access to the
 * Azure Blob Storage backend and the Key Vault key that encrypts secrets
 * in Pulumi state.
 *
 * Why this is in the workload Pulumi project (and not the bootstrap
 * script):
 *   The CI managed identity is itself created by the workload stack
 *   (identity.ts). The bootstrap script can't grant a role to an
 *   identity that doesn't exist yet. The cleanest split is:
 *     - Bootstrap script (scripts/bootstrap-pulumi-backend.sh):
 *       creates the state backend resources themselves (storage account,
 *       container, KV, key) and grants the *bootstrap human* access.
 *     - This file: looks up those two pre-existing resources by their
 *       ARM IDs (passed in via Pulumi config) and grants the CI managed
 *       identity the minimum roles it needs to run `pulumi up` on its own.
 *
 * Minimum roles granted:
 *   - Storage Blob Data Contributor — required for the azblob backend
 *     to read/write the state file. Pulumi uses RBAC (NOT the storage
 *     account key), and Reader isn't enough because state writes happen
 *     on every `pulumi up`.
 *   - Key Vault Crypto User — Pulumi's azurekeyvault secrets provider
 *     issues encrypt/decrypt against the key. Crypto User has exactly
 *     those four operations and nothing else (Crypto Officer / Admin
 *     would also let CI delete the key, which we don't want).
 *
 * Skipped if the two `cal:stateXxx` config values aren't set — useful
 * for laptop-only deploys where the human is the principal and CI doesn't
 * need its own access path yet.
 */
import * as pulumi from "@pulumi/pulumi";
import * as managedidentity from "@pulumi/azure-native/managedidentity";
import * as authorization from "@pulumi/azure-native/authorization";

export interface StateBackendAccessInputs {
  envSuffix: string;
  identity: managedidentity.UserAssignedIdentity;
  /** ARM resource ID of the Storage Account that holds Pulumi state.
   *  Captured by scripts/bootstrap-pulumi-backend.sh and set via
   *  `pulumi config set cal:stateStorageAccountId <id>`. */
  stateStorageAccountId: string | undefined;
  /** ARM resource ID of the Key Vault that holds the secrets-provider
   *  key. Set via `pulumi config set cal:stateKeyVaultId <id>`. */
  stateKeyVaultId: string | undefined;
}

// Built-in Azure role IDs (these are stable Microsoft IDs — don't change
// even across tenants, so it's safe to hardcode them).
const STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID =
  "ba92f5b4-2d11-453d-a403-e96b0029c9fe";
const KEY_VAULT_CRYPTO_USER_ROLE_ID = "12338af0-0e69-4776-bea7-57ae8d297424";

export function grantStateBackendAccess(inputs: StateBackendAccessInputs): void {
  const { envSuffix, identity, stateStorageAccountId, stateKeyVaultId } = inputs;

  if (!stateStorageAccountId && !stateKeyVaultId) {
    pulumi.log.info(
      "cal:stateStorageAccountId and cal:stateKeyVaultId not set; " +
        "skipping CI state-backend access grants. Set both to allow GitHub " +
        "Actions to run `pulumi up` against the Azure Blob backend.",
    );
    return;
  }

  if (stateStorageAccountId) {
    new authorization.RoleAssignment(
      `cal-${envSuffix}-state-storage-ra`,
      {
        scope: stateStorageAccountId,
        principalId: identity.principalId,
        principalType: "ServicePrincipal",
        // Role definition ARM path is global (no scope prefix needed
        // for built-in roles — `/subscriptions/...` is implicit).
        roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/${STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID}`,
      },
      { parent: identity },
    );
  } else {
    pulumi.log.warn(
      "cal:stateStorageAccountId not set — CI won't be able to read/write Pulumi state.",
    );
  }

  if (stateKeyVaultId) {
    new authorization.RoleAssignment(
      `cal-${envSuffix}-state-kv-ra`,
      {
        scope: stateKeyVaultId,
        principalId: identity.principalId,
        principalType: "ServicePrincipal",
        roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/${KEY_VAULT_CRYPTO_USER_ROLE_ID}`,
      },
      { parent: identity },
    );
  } else {
    pulumi.log.warn(
      "cal:stateKeyVaultId not set — CI won't be able to encrypt/decrypt secrets in Pulumi state.",
    );
  }
}
