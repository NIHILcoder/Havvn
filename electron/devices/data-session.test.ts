import { afterEach, expect, it } from "vitest";
import { dataPair } from "../../research/device-pairing/data-fixture";
import { openDeviceSessionServer, connectDeviceSession } from "./session";
const clean: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of clean.splice(0).reverse()) await close();
});
it("receives a portable operation through authenticated TLS and ACKs the renderer commit", async () => {
  const f = await dataPair();
  clean.push(f.close);
  f.ta.values.set("language", "ru");
  const op = await f.ra.publish("preferences", "language", "ru");
  const server = await openDeviceSessionServer(f.b, (session) =>
    f.rb.receiveOnce(session, async () => true),
  );
  clean.push(server.close);
  const client = await connectDeviceSession(f.a, server.port);
  clean.push(() => client.close());
  await client.send(op);
  const ack = await client.receive();
  expect(ack.kind).toBe("ack");
  expect(f.tb.values.get("language")).toBe("ru");
  expect(f.a.snapshot().outbox).toBe(0);
});
it("requires snapshot approval on the authenticated peer and carries the final watermark ACK over TLS", async () => {
  const f = await dataPair();
  clean.push(f.close);
  f.ta.values.set("language", "ru");
  await f.ra.publish("preferences", "language", "ru");
  const snapshot = f.a.dataSnapshot("preferences");
  let approve = false;
  const server = await openDeviceSessionServer(f.b, (session) =>
    f.rb.receiveOnce(session, async () => approve),
  );
  clean.push(server.close);
  const first = await connectDeviceSession(f.a, server.port);
  clean.push(() => first.close());
  await first.sendSnapshot(snapshot);
  await expect(first.receive()).rejects.toThrow();
  expect(f.tb.values.has("language")).toBe(false);
  expect(f.a.snapshot().outbox).toBe(1);
  approve = true;
  const next = await connectDeviceSession(f.a, server.port);
  clean.push(() => next.close());
  await next.sendSnapshot(snapshot);
  const ack = await next.receive();
  expect(ack.kind).toBe("ack");
  expect(f.tb.values.get("language")).toBe("ru");
  expect(f.a.snapshot().outbox).toBe(0);
});
