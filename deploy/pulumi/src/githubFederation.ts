/**
 * githubFederation.ts — Federated credentials for GitHub Actions.
 *
 * Lets GitHub workflows authenticate to Azure using OIDC tokens instead
 * of a stored service principal client secret. Result: no long-lived
 * credential in GitHub repo settings; tokens are minted per-run and
 * scoped to the specific repo + workflow + branch/environment.
 *
 * What this creates:
 *   - Federated identity credentials on the user-assigned managed identity
 *     from identity.ts. Each credential binds an OIDC token's `sub` claim
 *     to the identity's permission set. We register three subjects so
 *     three workflow modes work:
 *       1. Pushes / merges to `develop`  → `repo:OWNER/REPO:ref:refs/heads/develop`
 *       2. PR builds (any branch)        → `repo:OWNER/REPO:pull_request`
 *       3. Manual workflow_dispatch      → `repo:OWNER/REPO:environment:dev`
 *
 * Role assignments granted to the same identity (already done in
 * identity.ts: AcrPull on registry; keyvault.ts: Secrets User on vault).
 * Workflows also need permission to update Container Apps revisions
 * (which is what `pulumi up` does on the Pulumi side). That's the
 * "Contributor" role on the resource group — granted here so the CI
 * identity can apply Pulumi changes.
 *
 * GITHUB-SIDE setup (manual, runbook in CI_SETUP.md):
 *   - Add secrets to the repo: AZURE_CLIENT_ID, AZURE_TENANT_ID,
 *     AZURE_SUBSCRIPTION_ID. (These are NOT secrets in the security
 *     sense — they're just IDs — but GitHub stores them in the
 *     secrets store as a matter of convention.)
 *   - Add a `dev` GitHub environment that protects the deploy workflow
 *     (review required, etc.). Optional but recommended.
 *
 * If the repo name changes, update the `subjects` array below and re-run
 * `pulumi up`.
 */
import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as managedidentity from "@pulumi/azure-native/managedidentity";
import * as authorization from "@pulumi/azure-native/authorization";

export interface GitHubFederationInputs {
  resourceGroup: resources.ResourceGroup;
  envSuffix: string;
  identity: managedidentity.UserAssignedIdentity;
  /**
   * GitHub repo (`owner/name`) whose Actions workflows are allowed to
   * mint Azure OIDC tokens against this identity. `undefined` skips
   * federation (useful when running `pulumi up` from a laptop without
   * CI).
   */
  githubRepo: string | undefined;
}

// "Contributor" role — broad, scoped to the RG so the CI identity can
// only see Cal's resources. Required for `pulumi up` to create/update
// Container Apps, KV secrets, etc.
const CONTRIBUTOR_ROLE_ID = "b24988ac-6180-42a0-ab88-20f7382dd24c";

export function setupGitHubFederation(inputs: GitHubFederationInputs): void {
  const { resourceGroup, envSuffix, identity, githubRepo } = inputs;

  if (!githubRepo) {
    pulumi.log.warn(
      "cal:githubRepo not set; skipping GitHub federation. " +
        "Set with: pulumi config set cal:githubRepo <owner>/<name>",
    );
    return;
  }

  // Three subjects:
  //   develop-push: pushes to refs/heads/develop (the auto-deploy path)
  //   pull-request: PR builds (any branch)
  //   dev-environment: workflows that declare `environment: dev`
  //     (`sub` switches form when `environment:` is set)
  const subjects: Array<{ key: string; subject: string }> = [
    { key: "develop-push", subject: `repo:${githubRepo}:ref:refs/heads/develop` },
    { key: "pull-request", subject: `repo:${githubRepo}:pull_request` },
    { key: "dev-environment", subject: `repo:${githubRepo}:environment:dev` },
  ];

  // Azure's federated-identity-credential API serializes writes per parent
  // identity — concurrent creates against the same identity return
  // HTTP 409 (FederatedIdentityCredentialsInUpdating). Chain each one
  // on the previous via dependsOn so Pulumi creates them sequentially.
  let previous: managedidentity.FederatedIdentityCredential | undefined;
  for (const { key, subject } of subjects) {
    const cred: managedidentity.FederatedIdentityCredential =
      new managedidentity.FederatedIdentityCredential(
        `cal-${envSuffix}-fed-${key}`,
        {
          resourceGroupName: resourceGroup.name,
          resourceName: identity.name,
          federatedIdentityCredentialResourceName: `gha-${key}`,
          audiences: ["api://AzureADTokenExchange"],
          issuer: "https://token.actions.githubusercontent.com",
          subject,
        },
        {
          parent: identity,
          dependsOn: previous ? [previous] : [],
        },
      );
    previous = cred;
  }

  // Contributor on the RG so `pulumi up` can write resources here.
  new authorization.RoleAssignment(`cal-${envSuffix}-id-rg-contributor`, {
    principalId: identity.principalId,
    principalType: "ServicePrincipal",
    roleDefinitionId: pulumi.interpolate`/subscriptions/${getSubscriptionId()}/providers/Microsoft.Authorization/roleDefinitions/${CONTRIBUTOR_ROLE_ID}`,
    scope: resourceGroup.id,
  });
}

let cachedSubscriptionId: pulumi.Output<string> | undefined;
function getSubscriptionId(): pulumi.Output<string> {
  if (cachedSubscriptionId) return cachedSubscriptionId;
  cachedSubscriptionId = pulumi
    .output(authorization.getClientConfig())
    .apply((c) => c.subscriptionId);
  return cachedSubscriptionId;
}
