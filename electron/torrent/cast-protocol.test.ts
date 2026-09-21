import { createRequire } from 'node:module';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Exercise the installed Cast implementation, not a second copy of protobufjs.
const requireFromProject = createRequire(path.join(process.cwd(), 'package.json'));
const protocol = requireFromProject('castv2/lib/proto');
const textFrame = Buffer.from('08001201731a017222016e280032027b7d', 'hex');
const message = {
  protocolVersion: 0, sourceId: 's', destinationId: 'r', namespace: 'n',
  payloadType: 0, payloadUtf8: '{}',
};

beforeAll(async () => {
  // castv2 reads its bundled .proto asynchronously when first required.
  await vi.waitFor(() => protocol.CastMessage.serialize(message));
});

describe('Cast protocol with the maintained protobuf runtime', () => {
  it('preserves the fixed protobuf wire representation of text messages', () => {
    expect(Buffer.from(protocol.CastMessage.serialize(message))).toEqual(textFrame);
    expect(protocol.CastMessage.parse(textFrame)).toMatchObject(message);
  });

  it('preserves binary payloads and nested device authentication messages', () => {
    const payload = Buffer.from([0, 255, 128, 1]);
    const encoded = protocol.CastMessage.serialize({
      protocolVersion: 0, sourceId: 's', destinationId: 'r', namespace: 'n',
      payloadType: 1, payloadBinary: payload,
    });
    expect(Buffer.from(protocol.CastMessage.parse(encoded).payloadBinary)).toEqual(payload);
    const auth = protocol.DeviceAuthMessage.parse(protocol.DeviceAuthMessage.serialize({
      response: { signature: payload, clientAuthCertificate: payload, clientCa: [payload] },
    }));
    expect(Buffer.from(auth.response.signature)).toEqual(payload);
    expect(Buffer.from(auth.response.clientAuthCertificate)).toEqual(payload);
    expect(Buffer.from(auth.response.clientCa[0])).toEqual(payload);
  });

  it('rejects a truncated length-delimited payload', () => {
    expect(() => protocol.CastMessage.parse(textFrame.subarray(0, -1))).toThrow();
  });
});
