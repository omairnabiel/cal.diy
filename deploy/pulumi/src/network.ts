/**
 * network.ts — Virtual Network and subnets.
 *
 * One VNet, two subnets:
 *   - container-apps  → /23, delegated to Microsoft.App/environments.
 *                       Container Apps requires a /23 minimum for the
 *                       Consumption workload profile (smaller subnets
 *                       hit IP-exhaustion fast under autoscale).
 *   - private-endpoints → /24, holds the private endpoints for Postgres
 *                         Flexible Server and Key Vault. Keeping these
 *                         on a separate subnet means we can add network
 *                         security groups that block lateral movement
 *                         between data-plane and compute-plane without
 *                         breaking Container Apps' own east-west traffic.
 *
 * Address space `10.20.0.0/16` is large enough that we can split out
 * extra subnets for future services (Redis private endpoint, AKS if we
 * ever need it, jump-box for debugging) without renumbering.
 */
import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as network from "@pulumi/azure-native/network";

export interface NetworkInputs {
  resourceGroup: resources.ResourceGroup;
  envSuffix: string; // "dev", "prod", etc.
  tags: Record<string, string>;
}

export interface NetworkOutputs {
  vnet: network.VirtualNetwork;
  containerAppsSubnet: network.Subnet;
  privateEndpointsSubnet: network.Subnet;
}

export function createNetwork(inputs: NetworkInputs): NetworkOutputs {
  const { resourceGroup, envSuffix, tags } = inputs;

  const vnet = new network.VirtualNetwork(`cal-${envSuffix}-vnet`, {
    resourceGroupName: resourceGroup.name,
    addressSpace: {
      addressPrefixes: ["10.20.0.0/16"],
    },
    // Note: we DON'T declare subnets inline here. Inline subnet
    // declarations on VirtualNetwork conflict with the standalone
    // Subnet resources below when Pulumi tries to refresh — each one
    // tries to "own" the subnet list. Standalone Subnet resources are
    // the documented pattern for non-trivial VNets.
    tags,
  });

  // Container Apps consumption workload profile requires:
  //   - /23 minimum (so ≥ 512 IPs)
  //   - delegation to Microsoft.App/environments
  //   - empty NSG (or a permissive one) so the platform can wire up
  //     its own internal endpoints
  const containerAppsSubnet = new network.Subnet(
    `cal-${envSuffix}-cae-subnet`,
    {
      resourceGroupName: resourceGroup.name,
      virtualNetworkName: vnet.name,
      addressPrefix: "10.20.0.0/23",
      delegations: [
        {
          name: "container-apps-delegation",
          serviceName: "Microsoft.App/environments",
        },
      ],
      // We omit privateEndpointNetworkPolicies / privateLinkServiceNetworkPolicies
      // — defaults are correct for Container Apps subnets. Don't set them
      // explicitly because the API enforces specific combinations.
    },
    { parent: vnet }, // parent for logical tree clarity in `pulumi stack output`
  );

  const privateEndpointsSubnet = new network.Subnet(
    `cal-${envSuffix}-pe-subnet`,
    {
      resourceGroupName: resourceGroup.name,
      virtualNetworkName: vnet.name,
      addressPrefix: "10.20.2.0/24",
      // Private endpoint subnets MUST disable network policies so the
      // platform can attach the PE NIC. (Default is "Enabled" in newer
      // API versions; we set explicit for stability.)
      privateEndpointNetworkPolicies: "Disabled",
    },
    { parent: vnet },
  );

  // Stack outputs — emitted at `pulumi up` end so the next-phase files
  // (Postgres, Container Apps env) can read them without re-querying.
  pulumi.all([vnet.id, containerAppsSubnet.id, privateEndpointsSubnet.id])
    .apply(([vnetId, caeId, peId]) => {
      pulumi.log.info(`vnet:   ${vnetId}`);
      pulumi.log.info(`cae-sn: ${caeId}`);
      pulumi.log.info(`pe-sn:  ${peId}`);
    });

  return { vnet, containerAppsSubnet, privateEndpointsSubnet };
}
