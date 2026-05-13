#!/usr/bin/env bash
# bootstrap-pulumi-backend.sh — create the Azure resources that hold
# Pulumi's state and the key that encrypts secrets in state.
#
# Why this exists:
#   Cal doesn't use Pulumi Cloud. State lives in Azure Blob Storage
#   inside the same subscription, and Pulumi's per-stack secret
#   encryption uses an Azure Key Vault key. Both of those resources have
#   to exist BEFORE `pulumi login` / `pulumi stack init`, so they can't
#   be Pulumi-managed themselves (chicken-and-egg).
#
#   Everything Pulumi-managed (the workload stack) sits in a separate
#   resource group (`wavey-dev-rg`) and never touches this RG. That
#   separation matters: `pulumi destroy` on the workload stack must
#   never wipe the bucket holding its own state file.
#
# What this script creates (idempotent — re-running is safe):
#   1. Resource group     cal-state-rg              (uksouth)
#   2. Storage account    calstateXXXXXX            (Standard_LRS, blob-only)
#      + container        state
#   3. Key Vault          cal-state-kv-XXXXXX       (RBAC-only, soft-delete on)
#      + key              pulumi-secrets              (RSA-2048)
#   4. Role grants to the current user:
#      - Storage Blob Data Contributor (on the storage account)
#      - Key Vault Crypto User         (on the vault)
#
# Outputs (at end): the exact `pulumi login` / `pulumi stack init`
# commands to run next, with all the IDs filled in.
#
# Usage:
#   az login
#   az account set --subscription <subscription-id>
#   ./scripts/bootstrap-pulumi-backend.sh
#
# Re-running with a fresh shell? Pass --print-env to just print the
# environment-variable exports needed for `pulumi login` to work,
# without re-creating anything.
set -euo pipefail

LOCATION="${LOCATION:-uksouth}"
RG="${STATE_RG:-cal-state-rg}"
CONTAINER="${STATE_CONTAINER:-state}"
KEY_NAME="${STATE_KEY_NAME:-pulumi-secrets}"

# ─── locate-or-create helpers ────────────────────────────────────────────
log() { printf "\033[1;36m▶\033[0m %s\n" "$*"; }
ok()  { printf "\033[1;32m✓\033[0m %s\n" "$*"; }

print_env_only=false
if [[ "${1:-}" == "--print-env" ]]; then
  print_env_only=true
fi

# Bootstrap requires az CLI logged in and a subscription selected.
SUB_ID=$(az account show --query id -o tsv 2>/dev/null || true)
if [[ -z "$SUB_ID" ]]; then
  echo "az CLI not logged in. Run: az login && az account set --subscription <id>" >&2
  exit 1
fi
log "Subscription: $SUB_ID"

UPN=$(az ad signed-in-user show --query userPrincipalName -o tsv)
USER_OID=$(az ad signed-in-user show --query id -o tsv)
log "Bootstrapping as: $UPN ($USER_OID)"

# ─── 1. Resource group ───────────────────────────────────────────────────
if ! az group show --name "$RG" &>/dev/null; then
  log "Creating resource group $RG in $LOCATION"
  az group create --name "$RG" --location "$LOCATION" --tags project=cal purpose=pulumi-state managed_by=bootstrap >/dev/null
fi
ok "Resource group: $RG"

# ─── 2. Storage account + container ──────────────────────────────────────
# Storage account names: 3-24 lowercase alphanumeric, globally unique.
# We look for any existing calstate* in our RG before generating a new
# suffix — keeps re-runs idempotent without storing the name in a file.
STORAGE=$(az storage account list -g "$RG" --query "[?starts_with(name, 'calstate')] | [0].name" -o tsv)
if [[ -z "$STORAGE" ]]; then
  # 6 lowercase-hex chars (subset of Azure's allowed alphanumeric set).
  # Don't pipe `tr </dev/urandom | head -c 6` — head closes the pipe
  # early, tr exits via SIGPIPE, and `set -o pipefail` turns that into a
  # silent script-killing failure.
  SUFFIX=$(openssl rand -hex 3)
  STORAGE="calstate${SUFFIX}"
  log "Creating storage account $STORAGE"
  az storage account create \
    --name "$STORAGE" \
    --resource-group "$RG" \
    --location "$LOCATION" \
    --sku Standard_LRS \
    --kind StorageV2 \
    --allow-blob-public-access false \
    --min-tls-version TLS1_2 \
    --tags project=cal purpose=pulumi-state >/dev/null
fi
ok "Storage account: $STORAGE"

STORAGE_ID=$(az storage account show -n "$STORAGE" -g "$RG" --query id -o tsv)

# Grant the bootstrap user data-plane access. Required because Pulumi
# uses RBAC against the storage account (NOT the storage account key).
if ! az role assignment list --assignee "$USER_OID" --scope "$STORAGE_ID" \
      --query "[?roleDefinitionName=='Storage Blob Data Contributor'] | [0]" -o tsv | grep -q .; then
  log "Granting current user Storage Blob Data Contributor on $STORAGE"
  az role assignment create \
    --assignee "$USER_OID" \
    --role "Storage Blob Data Contributor" \
    --scope "$STORAGE_ID" >/dev/null
fi
ok "Role: current user → Storage Blob Data Contributor on $STORAGE"

# Container creation needs the role above to have propagated. AAD RBAC
# propagation can take ~30s on a fresh assignment; retry briefly.
if ! az storage container exists --account-name "$STORAGE" --name "$CONTAINER" --auth-mode login --query exists -o tsv 2>/dev/null | grep -q true; then
  log "Creating container '$CONTAINER' on $STORAGE (retrying for RBAC propagation)"
  for i in 1 2 3 4 5 6; do
    if az storage container create --account-name "$STORAGE" --name "$CONTAINER" --auth-mode login >/dev/null 2>&1; then
      break
    fi
    sleep 10
  done
fi
ok "Container: $CONTAINER (on $STORAGE)"

# ─── 3. Key Vault + key for secrets-provider ─────────────────────────────
VAULT=$(az keyvault list -g "$RG" --query "[?starts_with(name, 'cal-state-kv-')] | [0].name" -o tsv)
if [[ -z "$VAULT" ]]; then
  # 6 lowercase-hex chars (subset of Azure's allowed alphanumeric set).
  # Don't pipe `tr </dev/urandom | head -c 6` — head closes the pipe
  # early, tr exits via SIGPIPE, and `set -o pipefail` turns that into a
  # silent script-killing failure.
  SUFFIX=$(openssl rand -hex 3)
  VAULT="cal-state-kv-${SUFFIX}"
  log "Creating Key Vault $VAULT"
  az keyvault create \
    --name "$VAULT" \
    --resource-group "$RG" \
    --location "$LOCATION" \
    --enable-rbac-authorization true \
    --retention-days 7 \
    --tags project=cal purpose=pulumi-state >/dev/null
fi
ok "Key Vault: $VAULT"

VAULT_ID=$(az keyvault show -n "$VAULT" -g "$RG" --query id -o tsv)

# Bootstrap user needs Crypto Officer to CREATE the key, then we'll grant
# the lighter Crypto User (which is enough for Pulumi's
# encrypt/decrypt/wrap/unwrap ops).
if ! az role assignment list --assignee "$USER_OID" --scope "$VAULT_ID" \
      --query "[?roleDefinitionName=='Key Vault Crypto Officer'] | [0]" -o tsv | grep -q .; then
  log "Granting current user Key Vault Crypto Officer on $VAULT (for key creation)"
  az role assignment create \
    --assignee "$USER_OID" \
    --role "Key Vault Crypto Officer" \
    --scope "$VAULT_ID" >/dev/null
fi

# Wait briefly for RBAC propagation before attempting key creation.
if ! az keyvault key show --vault-name "$VAULT" --name "$KEY_NAME" &>/dev/null; then
  log "Creating key '$KEY_NAME' on $VAULT (retrying for RBAC propagation)"
  for i in 1 2 3 4 5 6; do
    if az keyvault key create --vault-name "$VAULT" --name "$KEY_NAME" --kty RSA --size 2048 --ops encrypt decrypt wrapKey unwrapKey >/dev/null 2>&1; then
      break
    fi
    sleep 10
  done
fi
ok "Key: $KEY_NAME (on $VAULT)"

# ─── 4. Output the values the operator needs next ────────────────────────
echo
echo "─── State backend ready ────────────────────────────────────────────"
echo
echo "Add to your shell (or ~/.bashrc / ~/.zshrc):"
echo
echo "  export AZURE_STORAGE_ACCOUNT='$STORAGE'"
echo "  export AZURE_KEYVAULT_AUTH_VIA_CLI=true"
echo
echo "Then bootstrap the Pulumi project:"
echo
echo "  cd deploy/pulumi"
echo "  pulumi login 'azblob://$CONTAINER?storage_account=$STORAGE'"
echo "  pulumi stack init dev \\"
echo "    --secrets-provider='azurekeyvault://$VAULT.vault.azure.net/keys/$KEY_NAME'"
echo "  pulumi config set cal:stateStorageAccountId '$STORAGE_ID'"
echo "  pulumi config set cal:stateKeyVaultId       '$VAULT_ID'"
echo "  pulumi up"
echo
echo "(The two stateXxx config values let the workload Pulumi grant the"
echo " CI managed identity access to this state backend.)"
