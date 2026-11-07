import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { tenantProof, withTenant } from "../src/index.ts";
import { attempt, connectTestDb, createTenant, insertRow, type TestDb } from "./helpers.ts";

// Migrations 018-021: SEC-010 (idempotency bound to the principal), SEC-012 (webhook URL CHECK), SEC-013 (one active membership
// per identity, deterministic lookup), SEC-003 (signed tenant context). docs/security/REVIEW-stage2.md.

let db: TestDb;
let A: string;
let B: string;

before(async () => {
  db = await connectTestDb({ max: 12 });
  A = await createTenant(db, "fix-a");
  B = await createTenant(db, "fix-b");
});
after(async () => {
  await db.close();
});

describe("SEC-010 idempotency rows are bound to the principal", () => {
  const voice = `credential:${randomUUID()}`;
  const widget = `credential:${randomUUID()}`;
  const insert = (principal: string | undefined, key: string, body: string) =>
    withTenant(db.app, A, (c) =>
      c.query(
        `insert into idempotency_keys (tenant_id, key, route, request_hash, status, response_status, response_body)
         values ($1, $2, 'tool:create_booking_hold', $3, 'completed', 200, $4::jsonb)
         on conflict on constraint idempotency_keys_unique_key do nothing returning id`,
        [A, key, body, JSON.stringify({ bookingId: body })]),
      principal === undefined ? {} : { principal });
  const lookup = (principal: string | undefined, key: string) =>
    withTenant(db.app, A, async (c) =>
      (await c.query<{ response_body: { bookingId: string }; principal: string }>(
        "select response_body, principal from idempotency_keys where tenant_id = $1 and key = $2 and route = 'tool:create_booking_hold'", [A, key])).rows,
      principal === undefined ? {} : { principal });

  it("the row records the principal from withTenant", async () => {
    const key = `call-${randomUUID()}-hold-1`;
    await insert(voice, key, "voice-booking");
    const rows = await lookup(voice, key);
    assert.deepEqual(rows.map((r) => r.principal), [voice]);
  });

  it("another credential repeating the same key and body gets a miss, not the first credential's response", async () => {
    const key = `call-${randomUUID()}-hold-1`;
    await insert(voice, key, "voice-booking");
    assert.deepEqual(await lookup(widget, key), [], "widget must not see voice's stored response");
    const mine = await insert(widget, key, "widget-booking");
    assert.equal(mine.rowCount, 1, "the second principal gets its own row instead of a conflict");
    assert.deepEqual((await lookup(voice, key)).map((r) => r.response_body.bookingId), ["voice-booking"]);
    assert.deepEqual((await lookup(widget, key)).map((r) => r.response_body.bookingId), ["widget-booking"]);
  });

  it("the same principal still gets exactly one row per key (replay / race unchanged)", async () => {
    const key = `key-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 8 }, () => insert(voice, key, "x").then((r) => r.rowCount)));
    assert.equal(results.filter((n) => n === 1).length, 1);
  });

  it("a row cannot be written for, or moved to, another principal", async () => {
    const key = `key-${randomUUID()}`;
    const forged = await attempt(db.app, A,
      "insert into idempotency_keys (tenant_id, key, route, request_hash, principal) values ($1, $2, 'r', 'h', $3)", [A, key, voice]);
    assert.ok(!forged.ok && forged.code === "42501", JSON.stringify(forged));
    await insert(voice, key, "x");
    const moved = await withTenant(db.app, A, (c) => c.query("update idempotency_keys set principal = $1 where key = $2", [widget, key]), { principal: voice })
      .then(() => "ok", (e: { code?: string }) => e.code);
    assert.equal(moved, "42501");
  });

  it("callers without a principal see only principal-less rows (the pre-018 behaviour)", async () => {
    const key = `key-${randomUUID()}`;
    await insert(undefined, key, "legacy");
    assert.equal((await lookup(undefined, key)).length, 1);
    assert.equal((await lookup(voice, key)).length, 0);
  });

  it("withTenant refuses a malformed principal", async () => {
    await assert.rejects(withTenant(db.app, A, async () => 1, { principal: "user:x' or '1'='1" }), TypeError);
    await assert.rejects(withTenant(db.app, A, async () => 1, { principal: "" }), TypeError);
  });
});

describe("SEC-012 webhook endpoint URLs", () => {
  const tryUrl = (url: string) =>
    attempt(db.app, A, "insert into webhook_endpoints (tenant_id, url, secret_ciphertext, events) values ($1, $2, 'x', '{booking.created}')", [A, url]);

  const refused = [
    "http://hooks.example.com/x",                  // not https
    "https://169.254.169.254/latest/meta-data/",   // metadata
    "https://127.0.0.1/", "https://127.1/", "https://2130706433/", "https://0x7f000001/", "https://0177.0.0.1/",
    "https://10.0.0.5/admin", "https://192.168.1.1/", "https://100.64.0.1/", "https://172.16.0.1/",
    "https://[::1]/", "https://[fd00::1]/", "https://[::ffff:127.0.0.1]/",
    "https://localhost/", "https://app.localhost/", "https://db/", "https://redis:6379/",
    "https://metadata.google.internal/", "https://printer.local/", "https://router.home.arpa/", "https://x.corp/",
    "https://kube-dns.kube-system.svc/",
    "https://user:pass@hooks.example.com/", "https://hooks.example.com@evil.example.net/", "https://hooks.example.com\\@evil.example.net/",
    "https://hooks.example.com:5432/", "https://hooks.example.com:22/",
    "https://hooks.example.com/ x", "https://hooks.exämple.com/", "HTTPS://hooks.example.com/", "https://hooks.example.com./",
    `https://${"a".repeat(64)}.example.com/`,
  ];
  for (const url of refused) {
    it(`refuses ${url}`, async () => {
      const r = await tryUrl(url);
      assert.ok(!r.ok && r.code === "23514", JSON.stringify(r));
    });
  }

  const accepted = [
    "https://hooks.example.com/x", "https://hooks.example.com", "https://hooks.example.com:443/a?b=c#d",
    "https://api.partner.co.in:8443/qenbel/hook", "https://xn--bcher-kva.example.com/path@literal",
    "https://hooks.example.com/?redirect=http://10.0.0.1/", // a path or query is not a target
  ];
  for (const url of accepted) {
    it(`accepts ${url}`, async () => {
      const r = await tryUrl(url);
      assert.ok(r.ok, JSON.stringify(r));
    });
  }

  it("rotation columns: a previous secret needs its expiry and vice versa", async () => {
    const id = await withTenant(db.app, A, (c) => insertRow(c, "webhook_endpoints", { tenant_id: A, url: "https://hooks.example.com/r", secret_ciphertext: "c", events: ["booking.created"] }));
    const bad = await attempt(db.app, A, "update webhook_endpoints set previous_secret_ciphertext = 'old' where id = $1", [id]);
    assert.ok(!bad.ok && bad.code === "23514");
    const good = await attempt(db.app, A,
      "update webhook_endpoints set previous_secret_ciphertext = 'old', previous_secret_expires_at = now() + interval '1 day', secret_key_version = 2 where id = $1", [id]);
    assert.ok(good.ok && good.rowCount === 1, JSON.stringify(good));
  });
});

describe("SEC-013 one external identity, one active membership", () => {
  const addUser = (t: string, subject: string) =>
    attempt(db.app, t, "insert into users (tenant_id, auth_provider, external_subject, name, role) values ($1, 'clerk', $2, 'Dual', 'STAFF')", [t, subject]);

  it("the same subject cannot be active in two tenants", async () => {
    const subject = `user_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    assert.ok((await addUser(A, subject)).ok);
    const second = await addUser(B, subject);
    assert.ok(!second.ok && second.code === "23505" && /users_identity_active_unique/.test(second.message), JSON.stringify(second));
    const r = await db.auth.query<{ tenant_id: string }>("select tenant_id from auth_lookup_user('clerk', $1)", [subject]);
    assert.deepEqual(r.rows.map((x) => x.tenant_id), [A]);
  });

  it("a disabled membership frees the identity; re-enabling the old one while the new one is active is refused", async () => {
    const subject = `user_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    assert.ok((await addUser(A, subject)).ok);
    assert.ok((await attempt(db.app, A, "update users set disabled_at = now() where external_subject = $1", [subject])).ok);
    assert.ok((await addUser(B, subject)).ok);
    const back = await attempt(db.app, A, "update users set disabled_at = null where external_subject = $1", [subject]);
    assert.ok(!back.ok && back.code === "23505", JSON.stringify(back));
    const r = await db.auth.query<{ tenant_id: string }>("select tenant_id from auth_lookup_user('clerk', $1)", [subject]);
    assert.deepEqual(r.rows.map((x) => x.tenant_id), [B]);
  });

  it("the duplicate clean-up of migration 020 keeps the oldest membership and audits the others (replayed in a rolled-back transaction)", async () => {
    const subject = `user_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const c = await db.owner.connect();
    try {
      await c.query("begin");
      await c.query("drop index users_identity_active_unique");
      await c.query("alter table users no force row level security");
      await c.query("alter table audit_log no force row level security");
      const older = randomUUID();
      const newer = randomUUID();
      await c.query("insert into users (id, tenant_id, auth_provider, external_subject, name, role, created_at) values ($1, $2, 'clerk', $3, 'Old', 'STAFF', now() - interval '1 day')", [older, A, subject]);
      await c.query("insert into users (id, tenant_id, auth_provider, external_subject, name, role) values ($1, $2, 'clerk', $3, 'New', 'OWNER')", [newer, B, subject]);
      await c.query(`
        WITH ranked AS (
          SELECT id, tenant_id, row_number() OVER w AS rn, first_value(id) OVER w AS kept_id
            FROM users WHERE disabled_at IS NULL
          WINDOW w AS (PARTITION BY auth_provider, external_subject ORDER BY created_at, id)
        ), disabled AS (
          UPDATE users u SET disabled_at = now() FROM ranked r WHERE u.id = r.id AND r.rn > 1
          RETURNING u.id, u.tenant_id, r.kept_id
        )
        INSERT INTO audit_log (tenant_id, actor_kind, action, entity_type, entity_id, outcome, details)
        SELECT tenant_id, 'system', 'users.duplicate_identity_disabled', 'user', id::text, 'success',
               jsonb_build_object('keptUserId', kept_id, 'reason', 'SEC-013 migration 020') FROM disabled`);
      const users = await c.query<{ id: string; disabled: boolean }>("select id, disabled_at is not null as disabled from users where external_subject = $1 order by created_at", [subject]);
      assert.deepEqual(users.rows, [{ id: older, disabled: false }, { id: newer, disabled: true }]);
      const audit = await c.query("select 1 from audit_log where entity_id = $1 and action = 'users.duplicate_identity_disabled' and tenant_id = $2", [newer, B]);
      assert.equal(audit.rowCount, 1);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("SEC-003 signed tenant context (migration 021)", () => {
  // Turns the proof on for this block with a random key and restores the run's setting afterwards.
  const key = randomBytes(32);
  const runKey = process.env.QENBEL_TENANT_PROOF_KEY;
  let custB = "";

  before(async () => {
    await db.platform.query("select platform_set_tenant_proof_keys($1)", [key]);
    custB = await withTenant(db.app, B, (c) => insertRow(c, "customers", { tenant_id: B, name: "Bob B" }), { proofKey: key });
    await withTenant(db.app, A, (c) => insertRow(c, "customers", { tenant_id: A, name: "Alice A" }), { proofKey: key });
  });
  after(async () => {
    if (runKey) await db.platform.query("select platform_set_tenant_proof_keys($1)", [Buffer.from(runKey, "hex")]);
    else await db.platform.query("select platform_clear_tenant_proof_keys()");
  });

  it("with the right proof a tenant sees its own rows", async () => {
    const rows = await withTenant(db.app, A, async (c) => (await c.query<{ name: string }>("select name from customers")).rows, { proofKey: key });
    assert.deepEqual(rows.map((r) => r.name), ["Alice A"]);
  });

  it("switching app.tenant_id inside tenant A's transaction no longer reaches tenant B (the PoC for SEC-003)", async () => {
    const rows = await withTenant(db.app, A, async (c) => {
      await c.query("select set_config('app.tenant_id', $1, true)", [B]);
      return (await c.query<{ id: string }>("select id from customers")).rows;
    }, { proofKey: key });
    assert.equal(rows.some((r) => r.id === custB), false);
    assert.equal(rows.length, 0, "a mismatched proof means no tenant at all");
  });

  it("writes into B are refused the same way", async () => {
    const r = await withTenant(db.app, A, async (c) => {
      await c.query("select set_config('app.tenant_id', $1, true)", [B]);
      return c.query("insert into customers (tenant_id, name) values ($1, 'planted')", [B]);
    }, { proofKey: key }).then(() => "ok", (e: { code?: string }) => e.code);
    assert.equal(r, "42501");
  });

  it("no proof, a wrong proof, or a proof made with another key: zero rows (fail closed)", async () => {
    for (const proofKey of [null, randomBytes(32)]) {
      const rows = await withTenant(db.app, A, async (c) => (await c.query("select 1 from customers")).rowCount, { proofKey });
      assert.equal(rows, 0);
    }
    const forged = await withTenant(db.app, A, async (c) => {
      await c.query("select set_config('app.tenant_proof', $1, true)", ["0".repeat(64)]);
      return (await c.query("select 1 from customers")).rowCount;
    }, { proofKey: null });
    assert.equal(forged, 0);
  });

  it("the runtime role cannot read the key", async () => {
    const r = await attempt(db.app, A, "select key from tenant_proof_keys");
    assert.ok(!r.ok && r.code === "42501");
    const h = await attempt(db.app, A, "select app_hmac_sha256('x'::bytea, 'y'::bytea)");
    assert.ok(!h.ok && h.code === "42501", "the HMAC helper is not callable by the runtime role");
  });

  it("the SQL HMAC equals RFC 4231 test case 2 and Node's createHmac", async () => {
    const c = await db.owner.connect();
    try {
      await c.query("begin");
      await c.query("set local role qenbel_platform");
      const rfc = await c.query<{ h: string }>("select encode(app_hmac_sha256(convert_to('Jefe', 'UTF8'), convert_to('what do ya want for nothing?', 'UTF8')), 'hex') as h");
      assert.equal(rfc.rows[0]?.h, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
      const long = randomBytes(100); // keys longer than the block size are hashed first
      const db1 = await c.query<{ h: string }>("select encode(app_hmac_sha256($1, convert_to($2, 'UTF8')), 'hex') as h", [long, `qenbel.tenant:${A}`]);
      assert.equal(db1.rows[0]?.h, tenantProof(long, A));
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("the proof matches the database's own computation, and the previous key keeps working during a rotation", async () => {
    const next = randomBytes(32);
    await db.platform.query("select platform_set_tenant_proof_keys($1, $2)", [next, key]);
    try {
      for (const k of [next, key]) {
        const n = await withTenant(db.app, A, async (c) => (await c.query("select 1 from customers")).rowCount, { proofKey: k });
        assert.equal(n, 1);
      }
      const manual = await withTenant(db.app, A, async (c) => {
        await c.query("select set_config('app.tenant_proof', $1, true)", [tenantProof(next, A).toUpperCase()]);
        return (await c.query("select current_tenant_id() as t")).rows[0]?.t;
      }, { proofKey: null });
      assert.equal(manual, A, "hex case does not matter");
    } finally {
      await db.platform.query("select platform_set_tenant_proof_keys($1)", [key]);
    }
  });

  it("the policy is evaluated once per statement and still uses the index", async () => {
    const plan = await withTenant(db.app, A, async (c) =>
      (await c.query<{ "QUERY PLAN": string }>("explain select * from customers where id = $1", [randomUUID()])).rows.map((r) => r["QUERY PLAN"]).join("\n"),
      { proofKey: key });
    assert.match(plan, /InitPlan/);
    assert.match(plan, /Index Scan|Index Only Scan|Bitmap/);
  });

  it("keys shorter than 32 bytes are refused", async () => {
    const r = await attempt(db.platform, null, "select platform_set_tenant_proof_keys($1)", [randomBytes(16)]);
    assert.ok(!r.ok && r.code === "22023");
  });
});
