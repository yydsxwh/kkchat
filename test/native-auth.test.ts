import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";
import { ChatError } from "../src/lib/domain";
import {
  NativeAuthService,
  parseAccessToken,
  signAccessToken,
  SOURCE_CHECK_HARD_LIMIT_MS,
  type AccountOidcClient,
  type SessionStatusClient,
} from "../src/lib/native-auth";
import { OidcError } from "../src/lib/oidc";
import { sweepRevokedSessions } from "../src/lib/session-sweeper";
import { CN_A, db, INTL_B, RecordingBus, resetDb, seedProjection } from "./support";

beforeEach(resetDb);

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

type Behaviour = { sid?: string | null; fail?: string; delayMs?: number; sub?: string };

class FakeOidc implements AccountOidcClient {
  calls = 0;
  audiences: string[] = [];
  constructor(public behaviour: Behaviour = {}) {}
  async exchangeCode(input: { clientId: string; redirectUri: string; code: string; codeVerifier: string }) {
    this.calls += 1;
    if (this.behaviour.delayMs) await new Promise((resolve) => setTimeout(resolve, this.behaviour.delayMs));
    if (this.behaviour.fail) throw new OidcError(this.behaviour.fail, "fail");
    assert.equal(input.redirectUri, "https://kkchat.test/native/auth/callback");
    return { idToken: `fake.${input.code}` };
  }
  async verifyIdToken(_token: string, expected: { audience: string; nonce: string }) {
    this.audiences.push(expected.audience);
    const sid = this.behaviour.sid === undefined ? "sess_account_1" : this.behaviour.sid;
    return { sub: this.behaviour.sub || INTL_B, name: "María López 🌍", kk_number: 10002, nonce: expected.nonce, ...(sid ? { sid } : {}) };
  }
}

class FakeStatus implements SessionStatusClient {
  alive = new Set<string>(["sess_account_1", "sess_account_2"]);
  failing = false;
  async check(sids: string[]) {
    if (this.failing) throw new Error("unreachable");
    return new Map(sids.map((sid) => [sid, this.alive.has(sid)]));
  }
}

function service(behaviour: Behaviour = {}) {
  const bus = new RecordingBus();
  const oidc = new FakeOidc(behaviour);
  const status = new FakeStatus();
  return { bus, oidc, status, auth: new NativeAuthService(db, bus, oidc, status) };
}

async function login(auth: NativeAuthService, platform: "android" | "ios" = "android") {
  const { verifier, challenge } = pkce();
  const started = await auth.start({ platform, codeChallenge: challenge, deviceName: "Surface Duo" });
  const state = new URL(started.authorizeUrl).searchParams.get("state")!;
  const input = { transactionId: started.transactionId, transactionSecret: started.transactionSecret, code: "code-1", state, codeVerifier: verifier };
  return { started, input, result: await auth.exchange(input) };
}

test("A01 授权地址带齐 PKCE / state / nonce，回调是登记的 https 地址；平台对应各自的 public client", async () => {
  const { auth, oidc } = service();
  const { verifier, challenge } = pkce();
  const started = await auth.start({ platform: "ios", codeChallenge: challenge, prompt: "login" });
  const url = new URL(started.authorizeUrl);
  assert.equal(url.origin, "https://account.test");
  assert.equal(url.searchParams.get("client_id"), "kkchat-ios");
  assert.equal(url.searchParams.get("code_challenge"), challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "https://kkchat.test/native/auth/callback");
  assert.equal(url.searchParams.get("prompt"), "login");
  assert.ok(url.searchParams.get("nonce"));
  assert.equal(url.searchParams.get("scope")?.includes("offline_access"), false);
  assert.equal(started.authorizeUrl.includes(verifier), false);
  const state = url.searchParams.get("state")!;
  await auth.exchange({ transactionId: started.transactionId, transactionSecret: started.transactionSecret, code: "c", state, codeVerifier: verifier });
  assert.deepEqual(oidc.audiences, ["kkchat-ios"]);
});

test("A01 成功换票建立一个设备会话；响应丢失后的短期重试拿回同一结果，不重复换票", async () => {
  const { auth, oidc } = service();
  const { input, result } = await login(auth);
  assert.equal(result.accountSub, INTL_B);
  assert.equal(result.user.displayName, "María López 🌍");
  const retry = await auth.exchange(input);
  assert.equal(retry.refreshToken, result.refreshToken);
  assert.equal(oidc.calls, 1);
  assert.equal(await db.deviceSession.count(), 1);
  const session = await db.deviceSession.findFirstOrThrow();
  assert.equal(session.accountSid, "sess_account_1");
  assert.equal(session.deviceName, "Surface Duo");
});

test("A01 并发交换只换一次票、只建一个会话", async () => {
  const { auth, oidc } = service({ delayMs: 50 });
  const { verifier, challenge } = pkce();
  const started = await auth.start({ platform: "android", codeChallenge: challenge });
  const state = new URL(started.authorizeUrl).searchParams.get("state")!;
  const input = { transactionId: started.transactionId, transactionSecret: started.transactionSecret, code: "c", state, codeVerifier: verifier };
  const results = await Promise.allSettled([auth.exchange(input), auth.exchange(input), auth.exchange(input)]);
  assert.equal(oidc.calls, 1);
  assert.equal(results.filter((item) => item.status === "fulfilled").length >= 1, true);
  assert.equal(await db.deviceSession.count(), 1);
});

test("A02 错 verifier、错事务密钥、错 state、过期、错 audience/nonce（账号中心拒绝）都不能登录", async () => {
  const { auth } = service();
  const { verifier, challenge } = pkce();
  const started = await auth.start({ platform: "android", codeChallenge: challenge });
  const state = new URL(started.authorizeUrl).searchParams.get("state")!;
  const base = { transactionId: started.transactionId, transactionSecret: started.transactionSecret, code: "c", state, codeVerifier: verifier };
  await assert.rejects(() => auth.exchange({ ...base, codeVerifier: pkce().verifier }), /PKCE/);
  await assert.rejects(() => auth.exchange({ ...base, transactionSecret: "guess" }), /登录事务无效/);
  await assert.rejects(() => auth.exchange({ ...base, state: "other" }), /state/);
  await assert.rejects(() => auth.exchange({ ...base, transactionId: randomUUID() }), /登录事务无效/);
  const later = new Date(Date.now() + 11 * 60 * 1000);
  await assert.rejects(() => auth.exchange(base, later), /restart_auth:expired/);
  assert.equal(await db.deviceSession.count(), 0);

  const rejecting = service({ fail: "invalid_grant" });
  const second = pkce();
  const s2 = await rejecting.auth.start({ platform: "android", codeChallenge: second.challenge });
  const st2 = new URL(s2.authorizeUrl).searchParams.get("state")!;
  const input2 = { transactionId: s2.transactionId, transactionSecret: s2.transactionSecret, code: "replayed", state: st2, codeVerifier: second.verifier };
  await assert.rejects(() => rejecting.auth.exchange(input2), /restart_auth:invalid_grant/);
  await assert.rejects(() => rejecting.auth.exchange(input2), /restart_auth:invalid_grant/);
  assert.equal(rejecting.oidc.calls, 1);
  assert.equal(await db.deviceSession.count(), 0);
});

test("A01 没有可撤销 sid 的旧兼容登录不签发长期设备会话，要求重新认证", async () => {
  const { auth } = service({ sid: null });
  await assert.rejects(() => login(auth), (error: unknown) => error instanceof ChatError && error.message === "reauth_required");
  assert.equal(await db.deviceSession.count(), 0);
});

test("A01 换票中途崩溃（EXCHANGING 卡住）后作废旧事务，引导重新授权", async () => {
  const { auth } = service();
  const { verifier, challenge } = pkce();
  const started = await auth.start({ platform: "android", codeChallenge: challenge });
  const state = new URL(started.authorizeUrl).searchParams.get("state")!;
  await db.nativeLoginTransaction.update({
    where: { id: started.transactionId },
    data: { status: "EXCHANGING", exchangeStartedAt: new Date(Date.now() - 60_000) },
  });
  await assert.rejects(
    () => auth.exchange({ transactionId: started.transactionId, transactionSecret: started.transactionSecret, code: "c", state, codeVerifier: verifier }),
    /restart_auth:exchange_interrupted/,
  );
});

test("聊天凭证不是账号中心令牌：篡改、过期、伪造都无效", async () => {
  const { auth } = service();
  const { result } = await login(auth);
  assert.ok(await auth.verifyAccess(result.accessToken));
  const parts = result.accessToken.split(".");
  assert.equal(await auth.verifyAccess([parts[0], parts[1], String(Number(parts[2]) + 999), parts[3]].join(".")), null);
  assert.equal(await auth.verifyAccess(`${result.accessToken}x`), null);
  assert.equal(await auth.verifyAccess("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c3JfMDEyMyJ9."), null);
  assert.equal(parseAccessToken(signAccessToken(randomUUID(), new Date(Date.now() - 1000))), null);
});

test("A03 刷新单次使用；同一 requestId 的重试与并发合并拿回同一结果；其他重放只撤销这台设备", async () => {
  const { auth } = service();
  const first = await login(auth);
  const second = await login(auth);
  const requestId = randomUUID();
  const concurrent = await Promise.all([
    auth.refresh({ refreshToken: first.result.refreshToken, requestId }),
    auth.refresh({ refreshToken: first.result.refreshToken, requestId }),
  ]);
  assert.equal(concurrent[0].refreshToken, concurrent[1].refreshToken);
  assert.equal(await db.deviceRefreshToken.count({ where: { sessionId: first.result.sessionId } }), 2);
  const retry = await auth.refresh({ refreshToken: first.result.refreshToken, requestId });
  assert.equal(retry.refreshToken, concurrent[0].refreshToken);
  const next = await auth.refresh({ refreshToken: retry.refreshToken, requestId: randomUUID() });
  assert.ok(await auth.verifyAccess(next.accessToken));

  await assert.rejects(() => auth.refresh({ refreshToken: first.result.refreshToken, requestId: randomUUID() }), /refresh_reused/);
  assert.equal(await auth.verifyAccess(next.accessToken), null);
  assert.ok((await db.deviceSession.findUniqueOrThrow({ where: { id: first.result.sessionId } })).revokedAt);
  assert.equal((await db.deviceSession.findUniqueOrThrow({ where: { id: second.result.sessionId } })).revokedAt, null);
  assert.ok(await auth.verifyAccess(second.result.accessToken));
});

test("A04 账号中心撤销会话后，巡检让设备会话与网页会话失效并断开实时连接", async () => {
  const { auth, bus, status } = service();
  const { result } = await login(auth);
  await seedProjection(CN_A, "小文");
  await db.browserSession.create({
    data: { id: "web-1", accountSub: INTL_B, accountSid: "sess_account_1", expiresAt: new Date(Date.now() + 86_400_000) },
  });
  await db.browserSession.create({
    data: { id: "web-2", accountSub: CN_A, accountSid: "sess_account_2", expiresAt: new Date(Date.now() + 86_400_000) },
  });
  status.failing = true;
  await assert.rejects(() => sweepRevokedSessions(db, bus, status));
  assert.ok(await auth.verifyAccess(result.accessToken));
  status.failing = false;
  status.alive.delete("sess_account_1");
  const swept = await sweepRevokedSessions(db, bus, status);
  assert.equal(swept.revoked, 2);
  assert.equal(await auth.verifyAccess(result.accessToken), null);
  assert.ok((await db.browserSession.findUniqueOrThrow({ where: { id: "web-1" } })).revokedAt);
  assert.equal((await db.browserSession.findUniqueOrThrow({ where: { id: "web-2" } })).revokedAt, null);
  assert.deepEqual(
    bus.disconnected.map((item) => item.sessionId).sort(),
    [result.sessionId, "web-1"].sort(),
  );
  await assert.rejects(() => auth.refresh({ refreshToken: result.refreshToken, requestId: randomUUID() }), /session_revoked/);
});

test("A04 刷新时来源会话已撤销立即失效；账号中心长时间不可达不无限延长", async () => {
  const { auth, status } = service();
  const { result } = await login(auth);
  await db.deviceSession.update({ where: { id: result.sessionId }, data: { sourceCheckedAt: new Date(Date.now() - SOURCE_CHECK_HARD_LIMIT_MS - 1000) } });
  status.failing = true;
  await assert.rejects(() => auth.refresh({ refreshToken: result.refreshToken, requestId: randomUUID() }), /暂时无法确认账号状态/);
  status.failing = false;
  status.alive.delete("sess_account_1");
  await assert.rejects(() => auth.refresh({ refreshToken: result.refreshToken, requestId: randomUUID() }), /session_revoked/);
});

test("退出撤销设备会话与推送绑定；推送令牌换账号后只属于新会话", async () => {
  const { auth } = service();
  const first = await login(auth);
  const session = await db.deviceSession.findUniqueOrThrow({ where: { id: first.result.sessionId } });
  await auth.registerPush(session, { provider: "FCM", token: "fcm-token-abcdefghijklmnop" });
  const other = service({ sub: CN_A, sid: "sess_account_2" });
  const second = await login(other.auth);
  const secondSession = await db.deviceSession.findUniqueOrThrow({ where: { id: second.result.sessionId } });
  await other.auth.registerPush(secondSession, { provider: "FCM", token: "fcm-token-abcdefghijklmnop" });
  const push = await db.pushDevice.findFirstOrThrow();
  assert.equal(push.accountSub, CN_A);
  assert.equal(push.sessionId, second.result.sessionId);
  await other.auth.revokeSession(second.result.sessionId, "logout");
  assert.ok((await db.pushDevice.findFirstOrThrow()).revokedAt);
  assert.equal(await other.auth.verifyAccess(second.result.accessToken), null);
  assert.ok(await auth.verifyAccess(first.result.accessToken));
});

test.after(async () => {
  await db.$disconnect();
});
