import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const gateSource = await readFile(new URL("./PeAccountGate.tsx", import.meta.url), "utf8");

test("desktop local mode retains settings and an optional cloud login entry", () => {
  assert.match(gateSource, /gateState.status === "local"[\s\S]*?<PeAccountMenu user=\{null\}/);
  assert.match(gateSource, /暂不登录，使用本地功能/);
  assert.match(gateSource, /desktopMode.current && error instanceof PeAccountClientError/);
});

test("keeps account verification separate from the signed-out state", () => {
  assert.match(gateSource, /useState<AccountGateState>\(\{ status: "checking" \}\)/);
  assert.match(gateSource, /gateState\.status === "checking"[\s\S]*?<AccountCheckingScreen \/>/);
  assert.match(gateSource, /gateState\.status === "unauthenticated"[\s\S]*?<AccountScreen/);
});

test("shows the login screen only after an explicit authentication rejection", () => {
  assert.match(
    gateSource,
    /error instanceof PeAccountClientError && \[401, 403\]\.includes\(error\.status\)[\s\S]*?setGateState\(\{ status: "unauthenticated" \}\)/,
  );
  assert.match(gateSource, /setGateState\(\{ status: "error", message: messageFor\(error\) \}\)/);
  assert.doesNotMatch(gateSource, /setMultiUser\(enabled\)/);
});

test("ignores stale account checks", () => {
  assert.match(gateSource, /const requestSequence = useRef\(0\)/);
  assert.match(gateSource, /sequence !== requestSequence\.current/);
});

test("offers a complete signed-out password reset flow", () => {
  assert.match(gateSource, /type AccountMode = "login" \| "register" \| "forgot"/);
  assert.match(gateSource, /sendPePasswordResetCode\(email\)/);
  assert.match(gateSource, /resetPeAccountPassword\(\{ email, code, newPassword: password \}\)/);
  assert.match(gateSource, /忘记密码？/);
  assert.match(gateSource, /两次输入的密码不一致/);
});

test("warns signed-in platform users before they submit with no balance", () => {
  assert.match(gateSource, /getPeModelServiceState\(\)/);
  assert.match(gateSource, /source === "platform" && Number\.isFinite\(balance\) && balance <= 0/);
  assert.match(gateSource, /平台模型暂不可用/);
  assert.match(gateSource, /PE_OPEN_MODELS_EVENT/);
});
