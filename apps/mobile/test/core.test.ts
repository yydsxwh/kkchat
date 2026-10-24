import assert from "node:assert/strict";
import test from "node:test";
import { computeLayout, MIN_PANE_DP } from "../src/layout-core";
import { parseAuthCallback, parseInviteToken } from "../src/links";
import type { NativeWindowLayout } from "../modules/kkchat-native/src/KkchatNative.types";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applySigning } = require("../plugins/with-release-signing.js") as { applySigning(contents: string): string };

const BASE = "https://kkchat.yydsxwh.com";

/** Surface Duo 2 跨双屏：两块 1344×1892 的屏中间是 66px 铰链，density 2.5。数值来自 Duo 2 的显示规格。 */
const duoSpanned: NativeWindowLayout = {
  windowWidth: 2754,
  windowHeight: 1892,
  density: 2.5,
  hasLayoutInfo: true,
  folds: [{ left: 1344, top: 0, right: 1410, bottom: 1892, orientation: "vertical", isSeparating: true, occlusion: "full", state: "flat" }],
};

test("Duo 跨屏竖向铰链：左右分栏，铰链宽度留空，即使状态是 FLAT", () => {
  const layout = computeLayout(duoSpanned, { width: 2754 / 2.5, height: 1892 / 2.5 });
  assert.equal(layout.mode, "split-row");
  if (layout.mode !== "split-row") return;
  assert.equal(layout.source, "hinge");
  assert.equal(layout.first, 1344 / 2.5);
  assert.equal(layout.gap, 66 / 2.5);
});

test("Duo 旋转后横向铰链：上下分栏，下半屏是完整聊天区，输入框不跨铰链", () => {
  const rotated: NativeWindowLayout = {
    ...duoSpanned,
    windowWidth: 1892,
    windowHeight: 2754,
    folds: [{ left: 0, top: 1344, right: 1892, bottom: 1410, orientation: "horizontal", isSeparating: true, occlusion: "full", state: "flat" }],
  };
  const layout = computeLayout(rotated, { width: 1892 / 2.5, height: 2754 / 2.5 });
  assert.equal(layout.mode, "split-column");
  if (layout.mode !== "split-column") return;
  assert.equal(layout.first, 1344 / 2.5);
  assert.equal(layout.gap, 66 / 2.5);
});

test("Duo 单屏、普通手机：单栏；没有分隔的折痕不拆分", () => {
  const single: NativeWindowLayout = { windowWidth: 1344, windowHeight: 1892, density: 2.5, hasLayoutInfo: true, folds: [] };
  assert.equal(computeLayout(single, { width: 1344 / 2.5, height: 1892 / 2.5 }).mode, "single");
  const foldableFlat: NativeWindowLayout = {
    ...single,
    folds: [{ left: 600, top: 0, right: 600, bottom: 1892, orientation: "vertical", isSeparating: false, occlusion: "none", state: "flat" }],
  };
  assert.equal(computeLayout(foldableFlat, { width: 1344 / 2.5, height: 1892 / 2.5 }).mode, "single");
  assert.equal(computeLayout(null, { width: 390, height: 844 }).mode, "single");
});

test("没有铰链的大窗口（平板 / iPad）分栏；窄分屏回退单栏", () => {
  const wide = computeLayout(null, { width: 1024, height: 768 });
  assert.equal(wide.mode, "split-row");
  assert.equal(wide.mode === "split-row" && wide.source, "wide");
  assert.equal(computeLayout(null, { width: 500, height: 900 }).mode, "single");
});

test("铰链太靠边、分出来的一块太窄时不分栏，退回完整单区域", () => {
  const edge: NativeWindowLayout = {
    windowWidth: 1200,
    windowHeight: 1800,
    density: 3,
    hasLayoutInfo: true,
    folds: [{ left: 300, top: 0, right: 330, bottom: 1800, orientation: "vertical", isSeparating: true, occlusion: "full", state: "flat" }],
  };
  const layout = computeLayout(edge, { width: 400, height: 600 });
  assert.equal(layout.mode, "single");
  assert.ok(300 / 3 <= MIN_PANE_DP);
});

test("邀请链接只认本站和 kkchat://，不含凭证", () => {
  const token = "AbCdEfGhIjKlMnOpQrStUv";
  assert.equal(parseInviteToken(`${BASE}/i/${token}`, BASE), token);
  assert.equal(parseInviteToken(`kkchat://i/${token}`, BASE), token);
  assert.equal(parseInviteToken(`https://evil.example/i/${token}`, BASE), null);
  assert.equal(parseInviteToken(`${BASE}/i/${token}/../../app`, BASE), null);
  assert.equal(parseInviteToken("javascript:alert(1)", BASE), null);
  assert.equal(parseInviteToken("not a url", BASE), null);
});

test("登录回调只认固定地址", () => {
  assert.deepEqual(parseAuthCallback("kkchat://auth/callback?code=c&state=s", BASE), { code: "c", state: "s", error: undefined });
  assert.deepEqual(parseAuthCallback(`${BASE}/native/auth/callback?code=c&state=s`, BASE), { code: "c", state: "s", error: undefined });
  assert.equal(parseAuthCallback("kkchat://evil/callback?code=c", BASE), null);
  assert.equal(parseAuthCallback("https://evil.example/native/auth/callback?code=c", BASE), null);
  assert.equal(parseAuthCallback(`${BASE}/native/auth/callbackX?code=c`, BASE), null);
});

test("release 构建改用正式签名，不再用 debug key；重复执行幂等", () => {
  const template = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution!
            signingConfig signingConfigs.debug
            minifyEnabled true
        }
    }
}`;
  const once = applySigning(template);
  assert.match(once, /release \{ \/\/ kkchat-release-signing/);
  assert.match(once, /release \{\n\s+\/\/ Caution!\n\s+signingConfig signingConfigs\.release/);
  assert.match(once, /refusing to sign a release with the debug key/);
  assert.equal(applySigning(once), once);
});
