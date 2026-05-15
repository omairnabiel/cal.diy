/**
 * Self-hosted Cal.diy infrastructure on Azure Container Apps.
 *
 * Standalone stack — independent of Wavey. Cal is consumed by Wavey via
 * its public URL + per-tenant API key, like a third-party service.
 *
 * Phases:
 *   1.  Resource group
 *   2.  Network (VNet + subnets)
 *   3.  Container Registry
 *   4.  Managed Identity (granted AcrPull on the registry up front)
 *   5.  Key Vault (managed identity gets KV Secrets User)
 *   6.  Container Apps Environment (in the VNet)
 *   7.  Postgres admin password (Pulumi-generated)
 *   8.  Postgres Flexible Server + calendso database
 *   9.  Redis (Container App in the CAE)
 *  10.  Secrets in Key Vault (Pulumi-managed + operator-set probes)
 *  11.  Cal.diy Container Apps (cal-web + cal-api) + migrations Job
 *  12.  GitHub Actions federated credentials
 *  13.  CI access to the Pulumi state backend
 *
 * To deploy:
 *   ./scripts/bootstrap-pulumi-backend.sh      # one-time per stack
 *   pulumi login azblob://state?storage_account=<account>
 *   pulumi -C deploy/pulumi stack init dev
 *   pulumi -C deploy/pulumi config set cal:stateStorageAccountId <id>
 *   pulumi -C deploy/pulumi config set cal:stateKeyVaultId <id>
 *   pulumi -C deploy/pulumi config set cal:githubRepo omairnabiel/cal.diy
 *   az login
 *   pulumi -C deploy/pulumi up
 */
import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as authorization from "@pulumi/azure-native/authorization";

import { createNetwork } from "./src/network";
import { createRegistry } from "./src/registry";
import { createIdentity } from "./src/identity";
import { createKeyVault } from "./src/keyvault";
import { createContainerAppsEnv } from "./src/containerappsenv";
import { createPostgres } from "./src/postgres";
import { createRedis } from "./src/redis";
import { generatePostgresPassword, setupSecrets } from "./src/secrets";
import { createContainerApps } from "./src/containerapps";
import { setupGitHubFederation } from "./src/githubFederation";
import { grantStateBackendAccess } from "./src/stateBackendAccess";

const stack = pulumi.getStack();
const envSuffix = stack;

const tags: Record<string, string> = {
  project: "cal",
  env: envSuffix,
  managed_by: "pulumi",
  pulumi_stack: pulumi.runtime.getProject() + "/" + stack,
};

const location = new pulumi.Config("azure-native").require("location");
const config = new pulumi.Config("cal");

// ─── 1. Resource Group ────────────────────────────────────────────────────
const resourceGroup = new resources.ResourceGroup(`cal-${envSuffix}-rg`, {
  resourceGroupName: `cal-${envSuffix}-rg`,
  location,
  tags,
});

// ─── 2. Network ───────────────────────────────────────────────────────────
const net = createNetwork({ resourceGroup, envSuffix, tags });

// ─── 3. Container Registry ────────────────────────────────────────────────
const registry = createRegistry({ resourceGroup, envSuffix, tags });

// ─── 4. Managed Identity ──────────────────────────────────────────────────
const identity = createIdentity({
  resourceGroup,
  envSuffix,
  tags,
  registry: registry.registry,
});

// ─── 5. Key Vault ─────────────────────────────────────────────────────────
const tenantId = pulumi
  .output(authorization.getClientConfig())
  .apply((c) => c.tenantId);

const vault = createKeyVault({
  resourceGroup,
  envSuffix,
  tags,
  principalId: identity.principalId,
  tenantId,
});

// ─── 6. Container Apps Environment ────────────────────────────────────────
const cae = createContainerAppsEnv({
  resourceGroup,
  envSuffix,
  tags,
  containerAppsSubnet: net.containerAppsSubnet,
});

// ─── 7. Postgres admin password ───────────────────────────────────────────
const { password: postgresAdminPassword } = generatePostgresPassword(envSuffix);

// ─── 8. Postgres Flexible Server + calendso db ────────────────────────────
const pg = createPostgres({
  resourceGroup,
  envSuffix,
  tags,
  vnet: net.vnet,
  adminPassword: postgresAdminPassword,
});

// ─── 9. Redis (Container App) ─────────────────────────────────────────────
const redis = createRedis({
  resourceGroup,
  envSuffix,
  tags,
  environment: cae.environment,
  containerAppsEnvDomain: cae.defaultDomain,
});

// ─── 10. Secrets in Key Vault ─────────────────────────────────────────────
const secrets = setupSecrets({
  resourceGroup,
  vault: vault.vault,
  envSuffix,
  postgresFqdn: pg.fqdn,
  postgresAdminLogin: pg.adminLogin,
  postgresAdminPassword,
  calendsoDbName: pg.calendsoDbName,
  redisUrl: redis.redisUrl,
});

// ─── 11. Cal Container Apps ───────────────────────────────────────────────
const apps = createContainerApps({
  resourceGroup,
  envSuffix,
  tags,
  environment: cae.environment,
  registry: registry.registry,
  identity: identity.identity,
  vault: vault.vault,
  availableSecretNames: secrets.availableNames,
});

// ─── 12. GitHub Actions federated credentials ─────────────────────────────
setupGitHubFederation({
  resourceGroup,
  envSuffix,
  identity: identity.identity,
  githubRepo: config.get("githubRepo"),
});

// ─── 13. CI access to the Pulumi state backend ────────────────────────────
grantStateBackendAccess({
  envSuffix,
  identity: identity.identity,
  stateStorageAccountId: config.get("stateStorageAccountId"),
  stateKeyVaultId: config.get("stateKeyVaultId"),
});

// ─── Stack outputs ────────────────────────────────────────────────────────
export const resourceGroupName = resourceGroup.name;
export const acrLoginServer = registry.loginServer;
export const acrName = registry.name;
export const identityResourceId = identity.identityId;
export const identityClientId = identity.clientId;
export const identityPrincipalId = identity.principalId;
export const keyVaultName = vault.vaultName;
export const keyVaultUri = vault.vaultUri;
export const containerAppsEnvId = cae.environmentId;
export const containerAppsEnvDomain = cae.defaultDomain;
export const vnetId = net.vnet.id;
export const containerAppsSubnetId = net.containerAppsSubnet.id;
export const privateEndpointsSubnetId = net.privateEndpointsSubnet.id;
export const postgresFqdn = pg.fqdn;
export const postgresCalendsoDb = pg.calendsoDbName;
export const redisInternalFqdn = redis.internalFqdn;
export const availableSecretNames = secrets.availableNames;
export const calWebUrl = pulumi.interpolate`https://${apps.calWebFqdn}`;
export const calApiFqdn = apps.calApiFqdn;
export const calApiUrl = pulumi.interpolate`https://${apps.calApiFqdn}`;
export const calMigrationsJobName = apps.calMigrationsJobName;

export const deploymentUrls = pulumi.all([apps.calWebFqdn, apps.calApiFqdn]).apply(([calWeb, calApi]) => ({
  calWeb: `https://${calWeb}`,
  calApi: `https://${calApi}`,
}));
