import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevAuthProvider, devAuthAllowed } from "../src/auth/devAuth.ts";
import { createAuthProvider } from "../src/auth/createAuthProvider.ts";

const memory = () => {
  let v: string | null = null;
  return { get: () => v, set: (x: string) => (v = x), clear: () => (v = null) };
};

test("dev auth runs only on the dev server AND on this machine", () => {
  assert.equal(devAuthAllowed({ dev: true, hostname: "localhost" }), true);
  assert.equal(devAuthAllowed({ dev: true, hostname: "127.0.0.1" }), true);
  assert.equal(devAuthAllowed({ dev: false, hostname: "localhost" }), false, "production build");
  assert.equal(devAuthAllowed({ dev: true, hostname: "admin.example.com" }), false, "real host");
  assert.equal(devAuthAllowed({ dev: true, hostname: "localhost.evil.example" }), false);
  assert.equal(devAuthAllowed({ dev: false, hostname: "admin.example.com" }), false);
});

test("the dev provider cannot be created outside dev", () => {
  assert.throws(() => createDevAuthProvider({ dev: false, hostname: "localhost" }, memory()), /cannot run here/);
  assert.throws(() => createDevAuthProvider({ dev: true, hostname: "example.com" }, memory()), /cannot run here/);
});

test("outside dev the app gets a provider that never signs anyone in", async () => {
  const p = createAuthProvider({ dev: false, hostname: "example.com" });
  assert.equal(p.kind, "none");
  assert.equal(await p.getSession(), null);
  await assert.rejects(() => p.signIn({ email: "a@b.c", password: "x" }), /not set up/);
});

test("dev provider signs in, restores and signs out", async () => {
  const p = createDevAuthProvider({ dev: true, hostname: "localhost" }, memory());
  assert.equal(await p.getSession(), null);
  const s = await p.signIn({ email: "owner@demo.test", password: "" });
  assert.equal(s.displayName, "owner");
  assert.deepEqual(await p.getSession(), s);
  await p.signOut();
  assert.equal(await p.getSession(), null);
  await assert.rejects(() => p.signIn({ email: "  ", password: "" }), /Enter your email/);
});
