import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toPaise } from "../src/index.ts";

describe("toPaise", () => {
  it("converts bigint strings from node-postgres to safe integers", () => {
    assert.equal(toPaise("123456"), 123456);
    assert.equal(toPaise(0), 0);
    assert.equal(toPaise(5n), 5);
  });
  it("refuses floats, unsafe integers, NaN and null", () => {
    assert.throws(() => toPaise("12.5"), RangeError);
    assert.throws(() => toPaise("9007199254740993"), RangeError);
    assert.throws(() => toPaise("abc"), RangeError);
    assert.throws(() => toPaise(null), TypeError);
  });
});
