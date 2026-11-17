import { CapabilityNotAllowedError, type Connector } from "./contracts.js";

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  constructor(connectors: Connector[]) {
    for (const connector of connectors) {
      if (this.connectors.has(connector.manifest.id)) {
        throw new Error(
          `Duplicate connector id: ${connector.manifest.id}`,
        );
      }
      this.connectors.set(connector.manifest.id, connector);
    }
  }

  get(connectorId: string): Connector {
    const connector = this.connectors.get(connectorId);
    if (!connector) {
      throw new CapabilityNotAllowedError(
        `Connector is not registered: ${connectorId}`,
      );
    }
    return connector;
  }

  getCapability(connectorId: string, capabilityId: string) {
    const capability = this.get(connectorId).manifest.capabilities.find(
      (item) => item.id === capabilityId,
    );
    if (!capability) {
      throw new CapabilityNotAllowedError(
        `Capability is not registered: ${connectorId}/${capabilityId}`,
      );
    }
    return capability;
  }

  list(): Connector[] {
    return [...this.connectors.values()];
  }
}
