// The pinned package has no bundled TypeScript declarations. Only the UPnP
// submodule is used; NAT-PMP and lease scheduling stay owned by our service.
declare module '@silentbot1/nat-api/lib/upnp/index.js' {
  export interface MappingOptions {
    public: number;
    private?: number;
    protocol: 'tcp' | 'udp';
    ttl?: number;
    description?: string;
  }
  export default class UpnpClient {
    constructor(options?: { permanentFallback?: boolean });
    findGateway(): Promise<unknown>;
    portMapping(options: MappingOptions): Promise<unknown>;
    portUnmapping(options: MappingOptions): Promise<unknown>;
    externalIp(): Promise<string>;
    destroy(): Promise<void>;
  }
}
