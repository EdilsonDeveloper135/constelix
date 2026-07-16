import assert from "node:assert/strict";
import test from "node:test";

import { describeWorkspace } from "./runtime.mjs";

test("describes the fixture workspace", () => {
  assert.equal(describeWorkspace("sample-workspace"), "Workspace: sample-workspace");
});
