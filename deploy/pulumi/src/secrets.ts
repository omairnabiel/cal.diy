/**
 * secrets.ts — Azure Key Vault is the single source of truth for secrets.
 *
 * Design:
 *   - Pulumi config is NOT used for secrets. The only secret values that
 *     pass through Pulumi state are the ones Pulumi itself generates
 *     (Postgres admin password, the 5 Cal cryptographic keys) and the
 *     composed DSN / Redis URL.
 *   - Operator-set externals (RESEND_API_KEY) are set out-of-band via
 *     `az keyvault secret set`. Container Apps read them at runtime
 *     under the user-assigned managed identity.
 *
 * On a fresh stack: first `pulumi up` writes the Pulumi-managed secrets
 * + probes KV for operator-set externals (none yet → empty list). The
 * Cal Container Apps come up with placeholder images that don't need
 * email. Operator sets `resend-api-key` via `az`, next `pulumi up`
 * re-probes and adds `RESEND_API_KEY` to the Container Apps' env.
 */
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as resources from "@pulumi/azure-native/resources";
import * as keyvault from "@pulumi/azure-native/keyvault";

/**
 * Operator-set externals that Cal Container Apps may reference. Today
 * the only one is RESEND_API_KEY (transactional email). Add new ones
 * here as they're needed; runtime wiring in containerapps.ts conditional
 * on presence in availableNames.
 */
export const EXTERNAL_SECRET_NAMES = ["resend-api-key"] as const;

export interface PostgresPasswordOutputs {
  password: pulumi.Output<string>;
}

/**
 * Strong random password for the Postgres admin role. Special-char set
 * excludes URL-significant chars (`@:/?&#`) so the composed DSN below
 * doesn't need exotic encoding.
 */
export function generatePostgresPassword(envSuffix: string): PostgresPasswordOutputs {
  const pw = new random.RandomPassword(`cal-${envSuffix}-pg-admin-pw`, {
    length: 32,
    special: true,
    overrideSpecial: "!#$%*-_+=.",
  });
  return { password: pw.result };
}

export interface SecretsInputs {
  resourceGroup: resources.ResourceGroup;
  vault: keyvault.Vault;
  envSuffix: string;
  postgresFqdn: pulumi.Output<string>;
  postgresAdminLogin: string;
  postgresAdminPassword: pulumi.Output<string>;
  calendsoDbName: pulumi.Output<string>;
  redisUrl: pulumi.Output<string>;
}

export interface SecretsOutputs {
  availableNames: pulumi.Output<string[]>;
}

export function setupSecrets(inputs: SecretsInputs): SecretsOutputs {
  const {
    resourceGroup,
    vault,
    envSuffix,
    postgresFqdn,
    postgresAdminLogin,
    postgresAdminPassword,
    calendsoDbName,
    redisUrl,
  } = inputs;

  const kvSecret = (name: string, value: pulumi.Input<string>): keyvault.Secret =>
    new keyvault.Secret(
      `cal-${envSuffix}-kvsec-${name}`,
      {
        secretName: name,
        resourceGroupName: resourceGroup.name,
        vaultName: vault.name,
        properties: { value },
      },
      { parent: vault },
    );

  // ─── Postgres admin password → KV ─────────────────────────────────────
  const adminPwSecret = kvSecret("postgres-admin-password", postgresAdminPassword);

  // ─── Composed DSN → KV ────────────────────────────────────────────────
  // URL-encode the password — the override-special set above keeps it
  // safe but encoding is cheap insurance.
  const dsn = pulumi
    .all([postgresFqdn, postgresAdminPassword, calendsoDbName])
    .apply(([host, pw, db]) =>
      `postgresql://${postgresAdminLogin}:${encodeURIComponent(pw)}@${host}:5432/${db}?sslmode=require`,
    );
  const dsnSecret = kvSecret("cal-database-url", dsn);

  // ─── Redis URL → KV ───────────────────────────────────────────────────
  const redisSecret = kvSecret("cal-redis-url", redisUrl);

  // ─── Cal cryptographic keys (5 generated) → KV ───────────────────────
  // overrideSpecial is restricted to URL/env-safe chars so values flow
  // through DSNs and shell quoting without percent-encoding hell.
  const SAFE_SPECIAL = "!-_+.";

  const nextauthSecret = new random.RandomPassword(`cal-${envSuffix}-nextauth-pw`, {
    length: 48,
    special: true,
    overrideSpecial: SAFE_SPECIAL,
  });
  const nextauthKv = kvSecret("cal-nextauth-secret", nextauthSecret.result);

  const encryptionKey = new random.RandomPassword(`cal-${envSuffix}-encryption-pw`, {
    length: 32,
    special: true,
    overrideSpecial: SAFE_SPECIAL,
  });
  const encryptionKv = kvSecret("cal-encryption-key", encryptionKey.result);

  const svcAcctKey = new random.RandomPassword(`cal-${envSuffix}-svcacct-pw`, {
    length: 32,
    special: true,
    overrideSpecial: SAFE_SPECIAL,
  });
  const svcAcctKv = kvSecret("cal-service-account-encryption-key", svcAcctKey.result);

  const videoTokenSecret = new random.RandomPassword(`cal-${envSuffix}-videotoken-pw`, {
    length: 48,
    special: true,
    overrideSpecial: SAFE_SPECIAL,
  });
  const videoTokenKv = kvSecret("cal-video-recording-token-secret", videoTokenSecret.result);

  const jwtSecret = new random.RandomPassword(`cal-${envSuffix}-jwt-pw`, {
    length: 48,
    special: true,
    overrideSpecial: SAFE_SPECIAL,
  });
  const jwtKv = kvSecret("cal-jwt-secret", jwtSecret.result);

  // ─── Stripe dummies → KV ─────────────────────────────────────────────
  // Cal v2 requires these env vars to exist for the NestJS config schema
  // to validate at startup, but the actual values are unused (billing
  // is stripped in Cal.diy). Stable literals stored in KV so the wiring
  // pattern matches everything else.
  const stripeApiKv = kvSecret("cal-stripe-api-key", "sk_test_dummy_1234567890");
  const stripeWebhookKv = kvSecret(
    "cal-stripe-webhook-secret",
    "whsec_dummy_1234567890",
  );

  // ─── Probe external secrets ──────────────────────────────────────────
  const pulumiManagedNames = [
    adminPwSecret.name,
    dsnSecret.name,
    redisSecret.name,
    nextauthKv.name,
    encryptionKv.name,
    svcAcctKv.name,
    videoTokenKv.name,
    jwtKv.name,
    stripeApiKv.name,
    stripeWebhookKv.name,
  ];

  const externalNames = pulumi
    .all([resourceGroup.name, vault.name, ...pulumiManagedNames])
    .apply(async ([rgName, vaultName]) => {
      const present: string[] = [];
      for (const name of EXTERNAL_SECRET_NAMES) {
        try {
          await keyvault.getSecret({
            resourceGroupName: rgName,
            vaultName,
            secretName: name,
          });
          present.push(name);
        } catch {
          // Operator hasn't set it yet (or vault is still creating on first run).
        }
      }
      return present;
    });

  const availableNames = pulumi
    .all([pulumi.all(pulumiManagedNames), externalNames])
    .apply(([managed, ext]) => [...managed, ...ext]);

  return { availableNames };
}
