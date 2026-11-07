import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppLogger, MemorySink, redact, scrubString } from "../src/common/logger.ts";

describe("logging redaction", () => {
  it("redacts secret-named keys at any depth", () => {
    const out = redact({ ok: 1, authorization: "Bearer abc", nested: { apiKey: "k", password: "p", deeper: [{ token: "t", fine: "f" }] }, API_KEY_PEPPER: "x", databaseUrl: "postgres://u:p@h/d" });
    const text = JSON.stringify(out);
    for (const secret of ["Bearer abc", '"k"', '"p"', '"t"', "postgres://u:p"]) assert.ok(!text.includes(secret), secret);
    assert.ok(text.includes('"fine":"f"'));
    assert.ok(text.includes('"ok":1'));
  });

  it("scrubs secret-shaped strings inside ordinary values", () => {
    const key = `qbk_AAAAAAAAAAAA.${"s".repeat(43)}`;
    const jwt = `eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.${"c".repeat(20)}`;
    const s = scrubString(`failed for ${key} with Bearer ${jwt} at postgres://qenbel_app:pw@localhost:5432/db and redis://:pw@h:1`);
    for (const secret of [key, jwt, "pw@", "qenbel_app"]) assert.ok(!s.includes(secret), secret);
  });

  it("log lines are JSON with level, time and message, and honour the level", () => {
    const sink = new MemorySink();
    const log = new AppLogger("warn", sink);
    log.info("hidden");
    log.warn("shown", { token: "secret-token", requestId: "r1" });
    assert.equal(sink.lines.length, 1);
    const rec = sink.records()[0] as Record<string, unknown>;
    assert.equal(rec.level, "warn");
    assert.equal(rec.msg, "shown");
    assert.equal(rec.requestId, "r1");
    assert.equal(rec.token, "[redacted]");
    assert.ok(typeof rec.ts === "string");
  });

  it("errors are logged as name, message and stack, scrubbed", () => {
    const sink = new MemorySink();
    new AppLogger("debug", sink).error("failed", { err: new Error("could not reach postgres://u:topsecret@db/x") });
    assert.ok(!sink.lines[0]?.includes("topsecret"));
  });

  it("a failing sink never throws into the request", () => {
    const log = new AppLogger("debug", { write: () => { throw new Error("disk full"); } });
    assert.doesNotThrow(() => log.error("x"));
  });
});
