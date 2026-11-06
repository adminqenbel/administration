import { test } from "node:test";
import assert from "node:assert/strict";
import { Channel, ToolName, ToolPermissionLevel } from "@qenbel/shared";
import { getTool, listTools, toolsForPack, UnknownToolError, TOOL_ERROR_CATALOGUE, ToolErrorCode } from "../src/index.ts";

// docs/ARCHITECTURE.md section 6, verbatim.
const EXPECTED_LEVELS: Record<string, string> = {
  get_business_profile: "READ",
  search_customer: "READ",
  get_catalogue: "READ",
  check_availability: "READ",
  create_booking_hold: "WRITE",
  confirm_booking: "CONTROLLED_WRITE",
  reschedule_booking: "CONTROLLED_WRITE",
  cancel_booking: "CONTROLLED_WRITE",
  get_order_status: "READ",
  create_order_draft: "WRITE",
  confirm_order: "CONTROLLED_WRITE",
  cancel_order: "CONTROLLED_WRITE",
  escalate_to_human: "WRITE",
};

test("registry holds exactly the 13 contract tools, in order, with no duplicates", () => {
  const names = listTools().map((t) => t.name);
  assert.equal(names.length, 13);
  assert.deepEqual(names, Object.keys(EXPECTED_LEVELS));
  assert.deepEqual([...names].sort(), Object.values(ToolName).sort());
  assert.equal(new Set(names).size, 13);
});

test("permission levels match ARCHITECTURE.md section 6", () => {
  for (const tool of listTools()) assert.equal(tool.permissionLevel, EXPECTED_LEVELS[tool.name], tool.name);
});

test("every write tool requires an idempotency key; read tools do not", () => {
  for (const tool of listTools()) {
    const isWrite = tool.permissionLevel === ToolPermissionLevel.WRITE || tool.permissionLevel === ToolPermissionLevel.CONTROLLED_WRITE;
    assert.equal(tool.requiresIdempotencyKey, isWrite, tool.name);
  }
  assert.equal(listTools().filter((t) => t.requiresIdempotencyKey).length, 8);
});

test("definitions are frozen", () => {
  for (const tool of listTools()) assert.ok(Object.isFrozen(tool), tool.name);
});

test("each tool has the metadata the gateway and docs need", () => {
  const channels = new Set<string>(Object.values(Channel));
  for (const tool of listTools()) {
    assert.ok(tool.title.length >= 3 && tool.title.length <= 40, `${tool.name} title`);
    assert.match(tool.requiredPermission, /^[a-z_]+:(read|write)$/, `${tool.name} permission`);
    assert.ok(tool.defaultChannels.length > 0, `${tool.name} channels`);
    for (const c of tool.defaultChannels) assert.ok(channels.has(c), `${tool.name}: unknown channel ${c}`);
    for (const code of tool.errorCodes) assert.ok(code in TOOL_ERROR_CATALOGUE, `${tool.name}: ${code} not in catalogue`);
    assert.ok(tool.examples.length >= 1, `${tool.name} needs an example`);
  }
});

test("channels: no tool that touches a named person's record is on public web chat or voice", () => {
  const named = ["search_customer", "reschedule_booking", "cancel_booking", "get_order_status", "cancel_order"];
  for (const n of named) {
    const tool = getTool(n);
    assert.ok(tool);
    assert.ok(!tool.defaultChannels.includes(Channel.WEB_CHAT), `${n} on web_chat`);
    assert.ok(!tool.defaultChannels.includes(Channel.VOICE), `${n} on voice`);
  }
  for (const tool of listTools()) assert.ok(!tool.defaultChannels.includes(Channel.DASHBOARD), `${tool.name} on dashboard`);
});

test("descriptions are plain, specific and say what the tool does not do", () => {
  for (const tool of listTools()) {
    assert.ok(tool.description.length >= 150 && tool.description.length <= 1200, `${tool.name} length ${tool.description.length}`);
    assert.match(tool.description, /\bDoes not\b/, `${tool.name} must state what it does not do`);
    assert.doesNotMatch(tool.description, /!|\b(amazing|seamless|powerful|revolutionary|guarantee[ds]?|best-in-class)\b/i, `${tool.name} hype`);
    assert.doesNotMatch(tool.description, /Qenbel|qenbel(?!\.)|QENBEL/, `${tool.name} brand spelling`);
  }
});

test("getTool", () => {
  assert.equal(getTool("check_availability")?.name, "check_availability");
  assert.equal(getTool("execute_sql"), undefined);
  assert.equal(getTool("__proto__"), undefined);
  assert.equal(getTool("constructor"), undefined);
});

test("toolsForPack keeps registry order, removes duplicates and rejects unknown names", () => {
  const picked = toolsForPack(["confirm_booking", "get_catalogue", "get_catalogue", "check_availability"]);
  assert.deepEqual(picked.map((t) => t.name), ["get_catalogue", "check_availability", "confirm_booking"]);
  assert.deepEqual(toolsForPack([]), []);
  assert.throws(() => toolsForPack(["get_catalogue", "execute_sql"]), UnknownToolError);
  assert.throws(() => toolsForPack(["GET_CATALOGUE"]), UnknownToolError);
});

test("error catalogue: every code has a status and a short plain message", () => {
  for (const code of Object.values(ToolErrorCode)) {
    const info = TOOL_ERROR_CATALOGUE[code];
    assert.ok(info, code);
    assert.ok(info.message.length > 10 && info.message.length < 120, code);
    assert.ok([400, 401, 403, 404, 409, 422, 429, 500].includes(info.httpStatus), code);
  }
});
