/** DP-02: loopback only. No startup registration, renderer IPC or data adapters. */
import {
  connect,
  checkServerIdentity,
  type Server,
  type TLSSocket,
} from "node:tls";
import { X509Certificate } from "node:crypto";
import { inspect } from "node:util";
import { DeviceError, type DevicePublic } from "../../shared/device-pairing";
import {
  checkDevicePublic,
  deviceDns,
  certificateHash,
  deviceHash,
} from "./identity";
import { DeviceVault } from "./vault";
import { DeviceWire } from "./wire";
import { deviceHost, devicePort } from "./network";

export const DEVICE_ALPN = "havvn-device-v1";
export function verifyDeviceSocket(
  socket: TLSSocket,
  peer?: DevicePublic,
): void {
  if (
    socket.getProtocol() !== "TLSv1.3" ||
    socket.isSessionReused() ||
    socket.alpnProtocol !== DEVICE_ALPN
  )
    throw new DeviceError("peer");
  socket.disableRenegotiation();
  if (!peer) return; // Bootstrap server authenticates B's signed exporter proof next.
  checkDevicePublic(peer);
  const raw = socket.getPeerCertificate().raw;
  if (!socket.authorized || !raw) throw new DeviceError("peer");
  try {
    const cert = new X509Certificate(raw);
    if (
      deviceHash(raw) !== certificateHash(peer) ||
      cert.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64") !==
        new X509Certificate(peer.certificate).publicKey
          .export({ format: "der", type: "spki" })
          .toString("base64") ||
      !cert.checkHost(deviceDns(peer.deviceId), {
        subject: "never",
        wildcards: false,
      })
    )
      throw Error();
  } catch {
    throw new DeviceError("peer");
  }
}
export function connectDevice(
  vault: DeviceVault,
  peer: DevicePublic,
  port: number,
  host = "127.0.0.1",
): Promise<DeviceWire> {
  checkDevicePublic(peer);
  deviceHost(host);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new DeviceError("invalid");
  return new Promise((resolve, reject) => {
    const socket = connect({
      host,
      port,
      servername: deviceDns(peer.deviceId),
      secureContext: vault.createTlsContext(peer),
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ALPNProtocols: [DEVICE_ALPN],
      checkServerIdentity: (name, cert) => checkServerIdentity(name, cert),
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new DeviceError("peer"));
    }, 5000);
    socket.on("error", () => {
      clearTimeout(timer);
      reject(new DeviceError("peer"));
    });
    socket.once("close", () => {
      clearTimeout(timer);
      reject(new DeviceError("peer"));
    });
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      try {
        verifyDeviceSocket(socket, peer);
        resolve(new DeviceWire(socket));
      } catch {
        socket.destroy();
        reject(new DeviceError("peer"));
      }
    });
  });
}
export async function listenDevice(
  vault: DeviceVault,
  peer: DevicePublic | undefined,
  handle: (wire: DeviceWire) => Promise<void>,
  rejected: (code: DeviceError["code"]) => void = () => {},
  endpoint = { host: "127.0.0.1", port: 0 },
) {
  deviceHost(endpoint.host);
  devicePort(endpoint.port, true);
  const report = (code: DeviceError["code"]) => {
    try {
      rejected(code);
    } catch {
      /* Diagnostics cannot change authorization. */
    }
  };
  const server: Server = vault.createTlsServer(peer),
    sockets = new Set<import("node:net").Socket>();
  let closed = false;
  server.maxConnections = 8;
  server.on("newSession", (_id, _data, done) => done());
  server.on("resumeSession", (_id, done) => done(null, null));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("tlsClientError", () => report("peer"));
  server.on("secureConnection", (socket) => {
    let wire: DeviceWire | undefined;
    void (async () => {
      try {
        verifyDeviceSocket(socket, peer);
        wire = new DeviceWire(socket);
        await handle(wire);
      } catch (error) {
        report(error instanceof DeviceError ? error.code : "peer");
      } finally {
        wire?.close();
        socket.destroy();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    const failed = () => reject(new DeviceError("peer"));
    server.once("error", failed);
    server.listen(endpoint.port, endpoint.host, () => {
      server.off("error", failed);
      resolve();
    });
  });
  server.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new DeviceError("state");
  return {
    port: address.port,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    toJSON: () => ({ port: address.port, closed }),
    [inspect.custom]: () => ({ port: address.port, closed }),
  };
}
