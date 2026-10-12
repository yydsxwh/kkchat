/**
 * 多账号、标签页独立身份的纯决策。
 *
 * 浏览器标签页之间共享 Cookie，所以 Cookie 不能单独代表「这个标签页是谁」。
 * 这里只规定：设备上可以挂多个已验证会话；每个标签页用一个随机上下文 id
 * 指向其中一枚。上下文 id 不是登录凭证，服务端还要核对设备 Cookie 和会话是否仍有效。
 *
 * 产品把数据库里的设备快照交进来，按返回的决定读写。不要在产品里再写一套
 * 「没有上下文就退回共享 Cookie 当前用户」的逻辑，否则两个标签页会串号。
 */

export const TAB_HEADER = "x-yyds-tab";
export const TAB_CLONE_HEADER = "x-yyds-tab-clone";
export const TAB_STORAGE_KEY = "yyds.tab.v1";
export const TAB_CLONE_STORAGE_KEY = "yyds.tab.cloneFrom";
export const DEVICE_COOKIE = "yyds_device";
export const HOLD_COOKIE_PREFIX = "yyds_hold_";

const CONTEXT_ID = /^[A-Za-z0-9_-]{16,80}$/;

export function isTabContextId(value: string | null | undefined): value is string {
  return typeof value === "string" && CONTEXT_ID.test(value);
}

export function holdCookieName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "");
  return `${HOLD_COOKIE_PREFIX}${safe}`;
}

/** 多账号开关。显式写成 0 才回到旧的单 Cookie 行为，便于整站回滚。 */
export function multiAccountTabsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MULTI_ACCOUNT_TABS !== "0";
}

export function maskEmail(email: string | null | undefined): string {
  const raw = String(email || "").trim().toLowerCase();
  const at = raw.indexOf("@");
  if (at <= 0) return "";
  return `${raw.slice(0, 1)}***${raw.slice(at)}`;
}

export function maskPhone(phone: string | null | undefined): string {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 7) return "";
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

export function hintSub(sub: string | null | undefined): string {
  const value = String(sub || "").trim();
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export type AccountDisplay = {
  name: string;
  kkNumber: string | null;
  emailMasked: string;
  phoneMasked: string;
  avatarUrl: string;
  subHint: string;
};

export type AccountRecord = {
  sessionId: string;
  userId: string;
  active: boolean;
  /** 该产品里真正授予的角色，不是用户自己填的 */
  grantedRoles: string[];
  /** 还没选工作台时用的默认角色，一般是优先级最高的已授角色 */
  defaultRole: string | null;
  pendingReview: boolean;
  /** 会话创建时间，秒。max_age 用它，不用客户端传来的值 */
  authTimeSec: number | null;
  display: AccountDisplay;
};

export type TabRecord = {
  contextId: string;
  sessionId: string | null;
  activeRole: string;
  revoked: boolean;
};

export type BrokerState = {
  /** 本设备已经同时登录过多个账号，新标签页必须点选 */
  explicitPick: boolean;
  defaultSessionId: string | null;
  accounts: AccountRecord[];
  tabs: TabRecord[];
};

export type AccountCard = {
  sessionId: string;
  userId: string;
  name: string;
  kkNumber: string | null;
  emailMasked: string;
  phoneMasked: string;
  avatarUrl: string;
  subHint: string;
  grantedRoles: string[];
  activeRole: string | null;
  status: "active" | "expired" | "pending";
  pendingReview: boolean;
  isDefault: boolean;
};

export type AccessDecision =
  | { kind: "legacy" }
  | { kind: "anonymous" }
  | { kind: "ambiguous"; accounts: AccountCard[] }
  | {
      kind: "ready";
      account: AccountRecord;
      activeRole: string | null;
      /** 用来鉴权的角色。只含当前工作台，不会把站长权限并进教师视图 */
      permissionRoles: string[];
      contextId: string | null;
    };

export function activeAccounts(state: BrokerState): AccountRecord[] {
  return state.accounts.filter((account) => account.active);
}

export function roleFor(account: AccountRecord, selected: string | null | undefined): string | null {
  if (selected && account.grantedRoles.includes(selected)) return selected;
  if (account.defaultRole && account.grantedRoles.includes(account.defaultRole)) {
    return account.defaultRole;
  }
  if (account.grantedRoles.length === 1) return account.grantedRoles[0];
  return null;
}

export function permissionRoles(account: AccountRecord, selected: string | null | undefined): string[] {
  const role = roleFor(account, selected);
  return role ? [role] : [];
}

export function toAccountCard(state: BrokerState, account: AccountRecord, selectedRole: string | null): AccountCard {
  const role = account.active ? roleFor(account, selectedRole) : null;
  return {
    sessionId: account.sessionId,
    userId: account.userId,
    name: account.display.name,
    kkNumber: account.display.kkNumber,
    emailMasked: account.display.emailMasked,
    phoneMasked: account.display.phoneMasked,
    avatarUrl: account.display.avatarUrl,
    subHint: account.display.subHint,
    grantedRoles: account.grantedRoles,
    activeRole: role,
    status: !account.active ? "expired" : account.pendingReview ? "pending" : "active",
    pendingReview: account.pendingReview,
    isDefault: state.defaultSessionId === account.sessionId,
  };
}

export function accountCards(state: BrokerState): AccountCard[] {
  return state.accounts.map((account) => {
    const tab = state.tabs.find((item) => !item.revoked && item.sessionId === account.sessionId);
    return toAccountCard(state, account, tab?.activeRole || null);
  });
}

function ready(account: AccountRecord, contextId: string | null, selected: string | null): AccessDecision {
  return {
    kind: "ready",
    account,
    activeRole: roleFor(account, selected),
    permissionRoles: permissionRoles(account, selected),
    contextId,
  };
}

/**
 * 只读判断当前请求是谁。不会把「另一个标签页刚登录的人」当成默认用户。
 * 没有设备记录时返回 legacy，由产品继续读旧的单会话 Cookie。
 */
export function resolveAccess(
  state: BrokerState | null,
  input: { enabled?: boolean; tabHeader: string | null | undefined },
): AccessDecision {
  if (input.enabled === false) return { kind: "legacy" };
  if (!state) return { kind: "legacy" };

  const header = input.tabHeader == null || input.tabHeader === "" ? null : input.tabHeader;
  if (header !== null && !isTabContextId(header)) return { kind: "anonymous" };

  const accounts = activeAccounts(state);
  const tab = header ? state.tabs.find((item) => item.contextId === header && !item.revoked) : undefined;

  if (tab?.sessionId) {
    const account = accounts.find((item) => item.sessionId === tab.sessionId);
    if (!account) return { kind: "anonymous" };
    return ready(account, header, tab.activeRole || null);
  }

  if (accounts.length === 1 && !state.explicitPick) {
    return ready(accounts[0], header, null);
  }
  if (accounts.length === 0) return { kind: "anonymous" };
  return { kind: "ambiguous", accounts: accountCards({ ...state, accounts }) };
}

export type TabMutation =
  | { op: "bind"; contextId: string; sessionId: string; activeRole: string }
  | { op: "clear-tab"; contextId: string }
  | { op: "revoke-session"; sessionId: string }
  | { op: "set-default"; sessionId: string | null }
  | { op: "mark-explicit" }
  | { op: "clear-explicit" }
  | { op: "revoke-device" };

export type ResumePlan = {
  decision: AccessDecision;
  mutations: TabMutation[];
};

function bindMutation(account: AccountRecord, contextId: string, selected: string | null): TabMutation {
  return {
    op: "bind",
    contextId,
    sessionId: account.sessionId,
    activeRole: roleFor(account, selected) || "",
  };
}

/** 标签页恢复、点选、复制标签页。调用方负责把 mutations 写进库。 */
export function planResume(
  state: BrokerState,
  input: {
    contextId: string | null | undefined;
    cloneFrom?: string | null;
    selectSessionId?: string | null;
    setDefault?: boolean;
  },
): ResumePlan {
  if (!isTabContextId(input.contextId)) {
    return { decision: { kind: "anonymous" }, mutations: [] };
  }
  const contextId = input.contextId;
  const accounts = activeAccounts(state);
  const mutations: TabMutation[] = [];

  if (input.selectSessionId) {
    const account = accounts.find((item) => item.sessionId === input.selectSessionId);
    if (!account) {
      return { decision: { kind: "ambiguous", accounts: accountCards(state) }, mutations: [] };
    }
    mutations.push(bindMutation(account, contextId, null));
    if (input.setDefault) mutations.push({ op: "set-default", sessionId: account.sessionId });
    return { decision: ready(account, contextId, null), mutations };
  }

  const existing = state.tabs.find((item) => item.contextId === contextId && !item.revoked);
  if (existing?.sessionId) {
    const account = accounts.find((item) => item.sessionId === existing.sessionId);
    if (account) return { decision: ready(account, contextId, existing.activeRole || null), mutations };
    mutations.push({ op: "clear-tab", contextId });
  }

  const cloneFrom = input.cloneFrom && isTabContextId(input.cloneFrom) ? input.cloneFrom : "";
  if (cloneFrom && cloneFrom !== contextId) {
    const source = state.tabs.find((item) => item.contextId === cloneFrom && !item.revoked && item.sessionId);
    const account = source?.sessionId
      ? accounts.find((item) => item.sessionId === source.sessionId)
      : undefined;
    if (account && source) {
      mutations.push(bindMutation(account, contextId, source.activeRole || null));
      return { decision: ready(account, contextId, source.activeRole || null), mutations };
    }
  }

  if (accounts.length === 1 && !state.explicitPick) {
    const account = accounts[0];
    mutations.push(bindMutation(account, contextId, null));
    return { decision: ready(account, contextId, null), mutations };
  }
  if (accounts.length === 0) return { decision: { kind: "anonymous" }, mutations };
  return { decision: { kind: "ambiguous", accounts: accountCards(state) }, mutations };
}

export function planRoleSwitch(
  state: BrokerState,
  input: { contextId: string | null | undefined; role: string },
): ResumePlan {
  if (!isTabContextId(input.contextId)) {
    return { decision: { kind: "anonymous" }, mutations: [] };
  }
  const tab = state.tabs.find((item) => item.contextId === input.contextId && !item.revoked);
  const account = tab?.sessionId
    ? activeAccounts(state).find((item) => item.sessionId === tab.sessionId)
    : undefined;
  if (!account || !account.grantedRoles.includes(input.role)) {
    return {
      decision: account
        ? ready(account, input.contextId, tab?.activeRole || null)
        : { kind: "ambiguous", accounts: accountCards(state) },
      mutations: [],
    };
  }
  return {
    decision: ready(account, input.contextId, input.role),
    mutations: [{ op: "bind", contextId: input.contextId, sessionId: account.sessionId, activeRole: input.role }],
  };
}

export type LogoutScope = "tab" | "account" | "browser";

export function planLogout(
  state: BrokerState,
  input: { scope: LogoutScope; contextId?: string | null; sessionId?: string | null },
): { mutations: TabMutation[] } {
  if (input.scope === "browser") {
    return {
      mutations: [
        ...activeAccounts(state).map((account) => ({ op: "revoke-session" as const, sessionId: account.sessionId })),
        { op: "revoke-device" },
      ],
    };
  }
  if (input.scope === "tab") {
    if (!isTabContextId(input.contextId)) return { mutations: [] };
    return { mutations: [{ op: "clear-tab", contextId: input.contextId }] };
  }
  const sessionId =
    input.sessionId ||
    (isTabContextId(input.contextId)
      ? state.tabs.find((item) => item.contextId === input.contextId && !item.revoked)?.sessionId
      : null);
  if (!sessionId) return { mutations: [] };
  return { mutations: [{ op: "revoke-session", sessionId }] };
}

export type AuthorizePlan =
  | { kind: "login"; reason: "none" | "prompt_login" | "max_age" }
  | { kind: "select"; accounts: AccountCard[] }
  | { kind: "issue"; sessionId: string; userId: string }
  | { kind: "error"; error: "login_required" | "account_selection_required" };

function promptsOf(value: string | string[] | null | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(" ") : String(value || "");
  return raw
    .split(/[\s+]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 授权码发给谁。login_hint 故意不参与判断，它只能帮界面把某张卡片排到前面。
 * postedSessionId 必须是本设备上仍然有效的会话，不能是任意用户 id。
 */
export function planAuthorize(input: {
  prompt?: string | string[] | null;
  state: BrokerState | null;
  tabHeader?: string | null;
  postedSessionId?: string | null;
  nowSec?: number;
  maxAgeSec?: number | null;
}): AuthorizePlan {
  const prompts = promptsOf(input.prompt);
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const state = input.state;
  const accounts = state ? activeAccounts(state) : [];
  const decision = resolveAccess(state, { tabHeader: input.tabHeader });
  const silent = prompts.includes("none");

  const tooOld = (account: AccountRecord) => {
    if (input.maxAgeSec == null || input.maxAgeSec < 0) return false;
    if (account.authTimeSec == null) return false;
    return now - account.authTimeSec > input.maxAgeSec;
  };

  if (prompts.includes("login")) {
    return silent
      ? { kind: "error", error: "login_required" }
      : { kind: "login", reason: "prompt_login" };
  }

  if (input.postedSessionId) {
    const account = accounts.find((item) => item.sessionId === input.postedSessionId);
    if (!account) {
      return silent
        ? { kind: "error", error: "account_selection_required" }
        : { kind: "select", accounts: state ? accountCards(state) : [] };
    }
    if (tooOld(account)) {
      return silent ? { kind: "error", error: "login_required" } : { kind: "login", reason: "max_age" };
    }
    return { kind: "issue", sessionId: account.sessionId, userId: account.userId };
  }

  if (prompts.includes("select_account")) {
    if (accounts.length === 0) {
      return silent ? { kind: "error", error: "login_required" } : { kind: "login", reason: "none" };
    }
    return silent
      ? { kind: "error", error: "account_selection_required" }
      : { kind: "select", accounts: accountCards(state as BrokerState) };
  }

  if (decision.kind === "ready") {
    if (tooOld(decision.account)) {
      return silent ? { kind: "error", error: "login_required" } : { kind: "login", reason: "max_age" };
    }
    return { kind: "issue", sessionId: decision.account.sessionId, userId: decision.account.userId };
  }

  if (!state || accounts.length === 0) {
    return silent ? { kind: "error", error: "login_required" } : { kind: "login", reason: "none" };
  }

  if (silent) {
    return accounts.length === 1 && !state.explicitPick
      ? { kind: "issue", sessionId: accounts[0].sessionId, userId: accounts[0].userId }
      : { kind: "error", error: "account_selection_required" };
  }
  return { kind: "select", accounts: accountCards(state) };
}

/** 登录成功后把账号挂到设备上。已有账号不会被踢掉。 */
export function planAddAccount(
  state: BrokerState | null,
  input: { contextId?: string | null; account: AccountRecord },
): { state: BrokerState; mutations: TabMutation[] } {
  const base: BrokerState = state || {
    explicitPick: false,
    defaultSessionId: null,
    accounts: [],
    tabs: [],
  };
  const others = base.accounts.filter((item) => item.userId !== input.account.userId);
  const accounts = [...others, input.account];
  const explicitPick = accounts.filter((item) => item.active).length > 1;
  const mutations: TabMutation[] = [];
  if (explicitPick && !base.explicitPick) mutations.push({ op: "mark-explicit" });
  if (!explicitPick && base.explicitPick) mutations.push({ op: "clear-explicit" });
  if (isTabContextId(input.contextId)) {
    mutations.push(bindMutation(input.account, input.contextId, null));
  }
  return {
    state: {
      ...base,
      explicitPick,
      accounts,
    },
    mutations,
  };
}

/**
 * 在页面脚本执行前给后续 fetch 带上标签页上下文。
 * 复制标签页会复制 sessionStorage，这里发现另一个活着的标签页占用同一上下文时换一个新 id，
 * 并把旧 id 留在 cloneFrom，交给恢复接口复制「账号选择」而不是共享退出按钮。
 */
export function tabBootstrapScript(): string {
  return `(function(){
var KEY=${JSON.stringify(TAB_STORAGE_KEY)};
var CLONE=${JSON.stringify(TAB_CLONE_STORAGE_KEY)};
var HEADER=${JSON.stringify(TAB_HEADER)};
function uuid(){
  if(window.crypto&&crypto.randomUUID) return crypto.randomUUID().replace(/-/g,"");
  return (Date.now().toString(36)+Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/gi,"").slice(0,32);
}
function valid(id){return typeof id==="string"&&/^[A-Za-z0-9_-]{16,80}$/.test(id);}
var id="";
try{id=sessionStorage.getItem(KEY)||"";}catch(e){id="";}
if(!valid(id)){id=uuid();try{sessionStorage.setItem(KEY,id);}catch(e){}}
var instance=uuid();
var beatKey="yyds.tab.live."+id;
try{
  var prev=JSON.parse(localStorage.getItem(beatKey)||"null");
  if(prev&&prev.instance&&prev.instance!==instance&&Date.now()-prev.t<2500){
    var next=uuid();
    sessionStorage.setItem(CLONE,id);
    sessionStorage.setItem(KEY,next);
    id=next;
    beatKey="yyds.tab.live."+id;
  }
}catch(e){}
function beat(){try{localStorage.setItem(beatKey,JSON.stringify({instance:instance,t:Date.now()}));}catch(e){}}
beat();
setInterval(beat,1000);
window.addEventListener("pagehide",function(event){
  if(event&&event.persisted) return;
  try{
    var cur=JSON.parse(localStorage.getItem(beatKey)||"null");
    if(cur&&cur.instance===instance) localStorage.removeItem(beatKey);
  }catch(e){}
});
var orig=window.fetch;
if(typeof orig==="function"){
  window.fetch=function(input,init){
    var headers=new Headers(init&&init.headers?init.headers:undefined);
    if(!headers.has(HEADER)) headers.set(HEADER,id);
    var next=Object.assign({},init||{},{headers:headers});
    if(typeof Request!=="undefined"&&input instanceof Request) return orig.call(this,new Request(input,next));
    return orig.call(this,input,next);
  };
}
window.__yydsTabContext=function(){return id;};
window.__yydsTabCloneFrom=function(){try{return sessionStorage.getItem(CLONE)||"";}catch(e){return "";}};
window.__yydsTabClearClone=function(){try{sessionStorage.removeItem(CLONE);}catch(e){}};
})();`;
}
