/** Callback API implemented by nat-pmp 1.x. */
declare module 'nat-pmp' {
  import { EventEmitter } from 'events';
  export interface MappingOptions {
    private: number;
    public?: number;
    ttl?: number;
    type: 'tcp' | 'udp';
  }
  export class Client extends EventEmitter {
    portMapping(options: MappingOptions, callback: (error: Error | null) => void): void;
    portUnmapping(options: MappingOptions, callback: (error: Error | null) => void): void;
    externalIp(callback: (error: Error | null, info?: { ip: number[] }) => void): void;
    close(): void;
  }
  export function connect(gateway: string): Client;
}
