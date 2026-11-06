import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_PERMISSIONS, Permission, ROLE_PERMISSIONS, UserRole, hasPermission, permissionsForRole } from "../src/index.ts";

test("permission strings are <module>:<action>", () => {
  for (const p of ALL_PERMISSIONS) assert.match(p, /^[a-z]+:[a-z]+$/);
  assert.equal(new Set(ALL_PERMISSIONS).size, ALL_PERMISSIONS.length);
  for (const p of ["bookings:read", "bookings:write", "orders:write", "customers:read", "catalogue:write", "resources:write", "business:write", "integrations:manage", "audit:read", "reports:read"]) {
    assert.ok((ALL_PERMISSIONS as readonly string[]).includes(p), p);
  }
});

test("OWNER has everything", () => {
  for (const p of ALL_PERMISSIONS) assert.ok(hasPermission(UserRole.OWNER, p), p);
});

test("MANAGER cannot change business settings, integrations or team", () => {
  assert.ok(hasPermission(UserRole.MANAGER, Permission.BOOKINGS_WRITE));
  assert.ok(hasPermission(UserRole.MANAGER, Permission.REPORTS_READ));
  assert.ok(hasPermission(UserRole.MANAGER, Permission.AUDIT_READ));
  assert.ok(hasPermission(UserRole.MANAGER, Permission.CATALOGUE_WRITE));
  assert.ok(!hasPermission(UserRole.MANAGER, Permission.BUSINESS_WRITE));
  assert.ok(!hasPermission(UserRole.MANAGER, Permission.INTEGRATIONS_MANAGE));
  assert.ok(!hasPermission(UserRole.MANAGER, Permission.USERS_MANAGE));
});

test("STAFF handles bookings, orders and customers only", () => {
  for (const p of [Permission.BOOKINGS_READ, Permission.BOOKINGS_WRITE, Permission.ORDERS_WRITE, Permission.CUSTOMERS_READ, Permission.CUSTOMERS_WRITE]) {
    assert.ok(hasPermission(UserRole.STAFF, p), p);
  }
  for (const p of [Permission.CATALOGUE_WRITE, Permission.RESOURCES_WRITE, Permission.BUSINESS_WRITE, Permission.INTEGRATIONS_MANAGE, Permission.AUDIT_READ, Permission.REPORTS_READ, Permission.USERS_MANAGE]) {
    assert.ok(!hasPermission(UserRole.STAFF, p), p);
  }
});

test("roles are nested: STAFF within MANAGER within OWNER", () => {
  const staff = new Set<string>(permissionsForRole(UserRole.STAFF));
  const manager = new Set<string>(permissionsForRole(UserRole.MANAGER));
  const owner = new Set<string>(permissionsForRole(UserRole.OWNER));
  for (const p of staff) assert.ok(manager.has(p), p);
  for (const p of manager) assert.ok(owner.has(p), p);
});

test("every write permission implies the matching read", () => {
  for (const role of Object.values(UserRole)) {
    for (const p of ROLE_PERMISSIONS[role]) {
      if (p.endsWith(":write")) assert.ok(hasPermission(role, p.replace(":write", ":read")), `${role} ${p}`);
    }
  }
});

test("deny by default for unknown roles and permissions", () => {
  assert.equal(hasPermission("ADMIN", Permission.BOOKINGS_READ), false);
  assert.equal(hasPermission("PLATFORM_ADMIN", Permission.BOOKINGS_READ), false);
  assert.equal(hasPermission(UserRole.OWNER, "execute:sql"), false);
  assert.equal(hasPermission(undefined, undefined), false);
  assert.equal(hasPermission("constructor", Permission.BOOKINGS_READ), false);
  assert.equal(hasPermission("__proto__", Permission.BOOKINGS_READ), false);
});

test("the map is frozen", () => {
  assert.ok(Object.isFrozen(ROLE_PERMISSIONS));
  assert.ok(Object.isFrozen(ROLE_PERMISSIONS.STAFF));
});
