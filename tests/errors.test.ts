import assert from "node:assert/strict";
import test from "node:test";

import { SaberError } from "../src/lib/errors.js";

test("SaberError preserves its name and message with a default exit code", () => {
  const error = new SaberError("default failure");

  assert.equal(error.name, "SaberError");
  assert.equal(error.message, "default failure");
  assert.equal(error.exitCode, 1);
});

test("SaberError accepts a custom exit code", () => {
  const error = new SaberError("unknown command", 2);

  assert.equal(error.exitCode, 2);
});
