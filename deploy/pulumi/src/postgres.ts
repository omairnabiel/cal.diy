/**
 * postgres.ts — Azure Database for PostgreSQL Flexible Server for Cal.diy.
 *
 * Single `calendso` database on a Burstable B1ms Flex server. VNet-injected
 * (private access only) — no public endpoint, no firewall rules. Container
 * Apps in the same VNet reach it via private DNS.
 *
 * Cal.diy's Prisma client uses standard SCRAM password auth. AAD-only mode
 * isn't supported.
 *
 * Subnet sizing: 10.20.4.0/24 — far from the Container Apps subnet
 * (10.20.0.0/23) and PE subnet (10.20.2.0/24) so neither squeezes the
 * other if we ever scale.
 *
 * Why the postgres subnet lives here (not network.ts): Flex requires
 * subnet delegation to `Microsoft.DBforPostgreSQL/flexibleServers` AND
 * an empty subnet at provisioning. Coupling the subnet's lifecycle to
 * the server's avoids ordering bugs.
 */
import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as dbforpostgresql from "@pulumi/azure-native/dbforpostgresql";
import * as network from "@pulumi/azure-native/network";
import * as privatedns from "@pulumi/azure-native/network";

export interface PostgresInputs {
  resourceGroup: resources.ResourceGroup;
  envSuffix: string;
  tags: Record<string, string>;
  vnet: network.VirtualNetwork;
  adminPassword: pulumi.Output<string>;
}

export interface PostgresOutputs {
  server: dbforpostgresql.Server;
  fqdn: pulumi.Output<string>;
  calendsoDbName: pulumi.Output<string>;
  adminLogin: string;
}

export function createPostgres(inputs: PostgresInputs): PostgresOutputs {
  const { resourceGroup, envSuffix, tags, vnet, adminPassword } = inputs;

  const adminLogin = "cal";

  // Dedicated subnet for Postgres Flexible Server
  const pgSubnet = new network.Subnet(`cal-${envSuffix}-pg-subnet`, {
    resourceGroupName: resourceGroup.name,
    virtualNetworkName: vnet.name,
    addressPrefix: "10.20.4.0/24",
    delegations: [
      {
        name: "flexible-servers-delegation",
        serviceName: "Microsoft.DBforPostgreSQL/flexibleServers",
      },
    ],
  });

  // Private DNS zone so the FQDN resolves inside the VNet. Zone name is
  // a hard-coded Azure platform requirement.
  const dnsZone = new privatedns.PrivateZone(`cal-${envSuffix}-pg-dnszone`, {
    resourceGroupName: resourceGroup.name,
    privateZoneName: "privatelink.postgres.database.azure.com",
    location: "global",
    tags,
  });

  const dnsLink = new privatedns.VirtualNetworkLink(
    `cal-${envSuffix}-pg-dnslink`,
    {
      resourceGroupName: resourceGroup.name,
      privateZoneName: dnsZone.name,
      virtualNetworkLinkName: `cal-${envSuffix}-pg-vnetlink`,
      location: "global",
      virtualNetwork: { id: vnet.id },
      registrationEnabled: false,
      tags,
    },
    { parent: dnsZone },
  );

  const server = new dbforpostgresql.Server(
    `cal-${envSuffix}-pg`,
    {
      serverName: `cal-${envSuffix}-pg`,
      resourceGroupName: resourceGroup.name,
      sku: {
        name: "Standard_B1ms",
        tier: "Burstable",
      },
      storage: {
        storageSizeGB: 32,
      },
      version: "16",
      administratorLogin: adminLogin,
      administratorLoginPassword: adminPassword,
      authConfig: {
        passwordAuth: "Enabled",
        activeDirectoryAuth: "Disabled",
      },
      network: {
        delegatedSubnetResourceId: pgSubnet.id,
        privateDnsZoneArmResourceId: dnsZone.id,
      },
      highAvailability: {
        mode: "Disabled",
      },
      backup: {
        backupRetentionDays: 7,
        geoRedundantBackup: "Disabled",
      },
      tags,
    },
    {
      dependsOn: [dnsLink],
    },
  );

  // Cal.diy's database. Prisma migrations create the rest of the schema
  // at first deploy via the migrations Job.
  const calendsoDb = new dbforpostgresql.Database(
    `cal-${envSuffix}-pg-db-calendso`,
    {
      databaseName: "calendso",
      serverName: server.name,
      resourceGroupName: resourceGroup.name,
      charset: "UTF8",
      collation: "en_US.utf8",
    },
    { parent: server },
  );

  return {
    server,
    fqdn: server.fullyQualifiedDomainName,
    calendsoDbName: calendsoDb.name,
    adminLogin,
  };
}
