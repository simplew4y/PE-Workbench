import assert from "node:assert/strict";
import test from "node:test";

import {
  humanizePeModelError,
  isPeInsufficientBalanceError,
  PE_INSUFFICIENT_BALANCE_MESSAGE,
} from "./pe-model-errors.ts";

test("recognizes upstream insufficient-balance responses", () => {
  assert.equal(
    isPeInsufficientBalanceError(
      new Error('402: {"message":"insufficient balance","code":"insufficient_balance"}'),
    ),
    true,
  );
  assert.equal(isPeInsufficientBalanceError("平台余额不足，请充值"), true);
  assert.equal(isPeInsufficientBalanceError("network unavailable"), false);
});

test("turns a raw 402 into an actionable Chinese message", () => {
  assert.equal(
    humanizePeModelError('Error: 402: {"type":"insufficient_balance"}'),
    PE_INSUFFICIENT_BALANCE_MESSAGE,
  );
  assert.equal(humanizePeModelError(new Error("ordinary failure")), "ordinary failure");
});
