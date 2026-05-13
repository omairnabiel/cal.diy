# Cal.diy infrastructure (Pulumi + Azure)

Self-hosted Cal.diy running on Azure Container Apps. Cal is a
*standalone* service that Wavey (and anyone else) integrates with over
its public URL + per-tenant API key — not via shared infrastructure.

## What this provisions

```
cal-${env}-rg
├── cal-${env}-vnet              VNet 10.20.0.0/16
│   ├── cal-${env}-cae-subnet     Container Apps environment
│   ├── cal-${env}-pe-subnet      Private endpoints
│   └── cal-${env}-pg-subnet      Postgres FS (delegated)
├── cal${env}acr                  Azure Container Registry
├── cal-${env}-identity           User-Assigned Managed Identity
├── cal-${env}-kv-<rand>          Key Vault (RBAC, soft-delete)
├── cal-${env}-cae                Container Apps Environment
├── cal-${env}-pg                 Postgres Flexible Server (B1ms, db `calendso`)
└── Container Apps:
    ├── cal-${env}-redis          redis:7-alpine, internal TCP :6379
    ├── cal-${env}-cal-web        Cal Next.js — external HTTPS :3000 (2 CPU / 4Gi)
    ├── cal-${env}-cal-api        Cal NestJS — internal HTTPS :5555
    └── cal-${env}-migrations     Container Apps Job (manual trigger)
```

Plus a separate `cal-state-rg` holding the Pulumi state Azure Storage
Account + the Key Vault key that encrypts secrets in state.

## Operator runbook — fresh stack from zero to green

```bash
# 1. Bootstrap the state backend (one-time per Azure subscription).
#    Creates cal-state-rg + a storage account + a Key Vault + a key.
#    Prints the cal:stateStorageAccountId / cal:stateKeyVaultId values
#    you'll need below.
./scripts/bootstrap-pulumi-backend.sh

# 2. Point Pulumi at the new backend.
export AZURE_KEYVAULT_AUTH_VIA_CLI=true
pulumi login "azblob://state?storage_account=<storage-account-from-step-1>"

# 3. Initialize the dev stack.
cd deploy/pulumi
pulumi stack init dev \
  --secrets-provider="azurekeyvault://<kv-from-step-1>.vault.azure.net/keys/pulumi-secrets"

# 4. Set config.
pulumi config set azure-native:location uksouth
pulumi config set cal:stateStorageAccountId '<storage-id-from-step-1>'
pulumi config set cal:stateKeyVaultId       '<kv-id-from-step-1>'
pulumi config set cal:githubRepo            'omairnabiel/cal.diy'

# 5. First apply — creates everything except the real images. cal-web /
#    cal-api come up with placeholder images. The migrations Job is
#    created but not triggered.
pulumi up

# 6. After step 5, the federated identity exists and stack outputs are
#    populated. Wire GitHub Actions:
#
#    On omairnabiel/cal.diy, Settings → Secrets and variables → Actions:
#      Secrets:
#        AZURE_CLIENT_ID         <pulumi stack output identityClientId>
#        AZURE_TENANT_ID         <your Azure AD tenant id>
#        AZURE_SUBSCRIPTION_ID   <your subscription id>
#      Variables:
#        PULUMI_BACKEND_STORAGE_ACCOUNT   <storage from step 1, name only>
#        PULUMI_BACKEND_CONTAINER         state

# 7. Set the Resend API key in KV (operator-set external — Pulumi never
#    sees the value).
az keyvault secret set \
  --vault-name "$(pulumi stack output keyVaultName)" \
  --name resend-api-key \
  --value 're_xxxxxxxxxxxxxx'

# 8. Push to `develop`. GitHub Actions:
#    - builds cal-web (Dockerfile) and cal-api (Dockerfile.api-v2)
#    - pushes them to the ACR
#    - sets cal:calWebImage / cal:calApiImage in Pulumi config
#    - runs `pulumi up` → cal-web + cal-api roll new revisions with the real images
git push origin develop

# 9. After CI's first deploy lands, run migrations once:
az containerapp job start \
  --name "$(pulumi stack output calMigrationsJobName)" \
  --resource-group "$(pulumi stack output resourceGroupName)"

# 10. Open `pulumi stack output calWebUrl`, log in as
#     admin@example.com / ADMINadmin2022! (from the Cal seed). Change
#     the password immediately.
```

## Wavey integration

Wavey's backend talks to Cal via the public URL set in its own
`CALENDAR_API_BASE_URL` env variable. Point it at:

```
CALENDAR_API_BASE_URL = https://<cal-web FQDN>/api/v2
```

cal-web internally proxies `/api/v2/*` to cal-api (which has no public
ingress). Auth is by per-tenant API key (`Authorization: Bearer cal_…`)
which Wavey stores per-merchant in its `clients` table.

Optionally allowlist Wavey's domains in Cal so cookies and CORS work:
add Wavey's URLs to the `ALLOWED_HOSTNAMES` env (currently set in
containerapps.ts to include only Cal's own FQDN).

## Secret rotation

```bash
# Rotate any KV-resident secret without touching Pulumi state:
az keyvault secret set --vault-name $(pulumi stack output keyVaultName) \
  --name resend-api-key --value 're_new_value'

# Cal Container Apps roll a new revision automatically because their
# `secrets` array is single-revision-mode. New revision picks up the
# new secret version.
```

To rotate a Pulumi-generated secret (e.g. `cal-jwt-secret`), taint the
`random.RandomPassword` resource and run `pulumi up`:

```bash
pulumi state delete urn:pulumi:dev::cal::random:index/randomPassword:RandomPassword::cal-dev-jwt-pw
pulumi up   # generates a fresh value, writes to KV, rolls a revision
```

## Cost (dev stack, idle estimate)

| Resource | Monthly |
|---|---|
| Container Apps consumption (cal-web 2cpu/4gi, cal-api 1cpu/2gi, redis 0.25cpu/0.5gi) | ~$50 |
| Postgres Flexible Server B1ms | ~$25 |
| ACR Basic | ~$5 |
| Key Vault (Premium not required) | ~$0 |
| **~$80/mo** | |

## Troubleshooting

**`pulumi up` first run fails on Redis 403 / Microsoft.Cache:** This stack
doesn't use Azure Cache for Redis. If you see it, you're running an old
copy of `redis.ts` — pull latest.

**`pulumi up` fails with `Microsoft.X not registered` on a fresh
subscription:** one-time, manually register:

```bash
for ns in Microsoft.App Microsoft.ContainerRegistry Microsoft.KeyVault \
          Microsoft.ManagedIdentity Microsoft.DBforPostgreSQL Microsoft.Network \
          Microsoft.OperationalInsights; do
  az provider register --namespace "$ns" --wait
done
```

**Federation 409 on `pulumi up`:** an orphan federated credential from a
prior failed run. List + delete:

```bash
IDENTITY_NAME=$(pulumi stack output identityResourceId | awk -F'/' '{print $NF}')
az identity federated-credential list \
  --identity-name "$IDENTITY_NAME" \
  --resource-group "$(pulumi stack output resourceGroupName)" -o table
# delete by name:
az identity federated-credential delete \
  --identity-name "$IDENTITY_NAME" \
  --resource-group "$(pulumi stack output resourceGroupName)" \
  --name <name> --yes
```

**Migrations Job fails:** check job execution logs:

```bash
JOB=$(pulumi stack output calMigrationsJobName)
RG=$(pulumi stack output resourceGroupName)
az containerapp job execution list --name "$JOB" --resource-group "$RG" -o table
az containerapp job logs show --name "$JOB" --resource-group "$RG" --container migrations
```
