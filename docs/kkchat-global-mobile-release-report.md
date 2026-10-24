# KKChat 全球好友 · Android / iOS · Surface Duo 发布报告

时间一律为北京时间（UTC+8）。状态只认这次真实跑过的检查：**PASS** 实测通过；**FAIL** 实测失败；**NOT_VERIFIED** 代码已就绪但没有能跑的环境；**BLOCKED** 缺账号、凭证或设备，做不下去。

## 0. 先回答五个问题

1. **国内用户和国外用户现在能互加好友吗？** 能。生产环境实测两次：网页上「KKChat测试·上海（KK 203）」按 KK 号加「KKChat Test · Kuala Lumpur（KK 205）」，对方同意后双向实时聊天、已读回执正常（录屏）；原生协议上「上海（203）」与「Madrid（204）」用 Android / iOS 两个 public client 登录后互加、聊天、拉黑、重加（29 项全过）。好友规则里没有地区、区号、IP、语言判断。
2. **Android 能从官网安装吗？** 官网已发布正式签名的 1.0.0：<https://www.yydsxwh.com/products/kkchat> →「下载 Android 版」，直链 <https://kkchat.yydsxwh.com/downloads/android/kkchat-1.0.0-1.apk>。签名、哈希、公开整包下载都核对过。**但这次没有任何能装 APK 的设备或模拟器（云主机没有 KVM / binder），真机安装、首次启动、App 内升级是 NOT_VERIFIED。**
3. **iOS 到哪一步？** 代码与原生工程能生成（同一套 React Native 代码，`expo prebuild` 生成 Xcode 工程），登录用的 `kkchat-ios` public client 已在账号中心登记，后端 iOS 登录流程在生产上实测通过。**模拟器构建、签名、真机、TestFlight、App Store 全部 BLOCKED**：没有 macOS / Xcode，也没有 Apple Developer 账号、Team ID、证书。iPhone 用户目前用网页版。
4. **Surface Duo？** 用 Jetpack WindowManager 的 `FoldingFeature` 读铰链，不看机型字符串；单屏、横跨、旋转三种布局按 Duo 2 的真实几何做了单测。**Duo 真机和 Duo 模拟器都没有跑过：NOT_VERIFIED。**
5. **剩下的阻塞** 见第 12 节：Apple 开发者账号与 Mac 构建机、APNs / FCM 推送凭证、找回密码用的邮件服务、能装 APK 的 Android 真机或带 KVM 的构建机、Duo 设备、中国大陆网络测试点；另外生产上还没指定举报审核员。

## 1. 结果总表

| 编号 | 项目 | 结果 | 证据 / 说明 |
|---|---|---|---|
| G01 | 国内用户按 KK 号加海外用户，对方同意 | PASS | 生产网页录屏；原生 E2E「G01/F01」 |
| G02 | 海外用户邮箱注册、登录、回到 App | PASS（注册 / 登录） | 测试账号均为邮箱注册；英文登录页 `ui_locales=en` 生产实测 |
| G02b | 海外用户找回密码 | BLOCKED | 账号中心没有可用的邮件服务（见 12） |
| G03 | 按 KK 号 / 账号精确查找 | PASS | 原生 E2E「G03/G04」；按昵称只做模糊匹配且受隐私开关控制 |
| G04 | 二维码 / 邀请链接加好友 | PASS（服务端）/ NOT_VERIFIED（App 扫码） | 集成测试：KK 号、账号、二维码链接找到同一个人，链接本身不授予读取权；App 扫码需真机 |
| G05 | 规则不依赖地区、区号、IP、语言 | PASS | 代码与测试里没有这些判断；测试用户没有国家字段 |
| G06 | 国际手机号 | 未实现 | 手机号登录仍只支持中国大陆号码，页面已标明，海外用户走邮箱 |
| F01 | 申请 / 同意 / 拒绝 / 撤销 / 过期 | PASS | `test/friends.test.ts`；生产 E2E |
| F02 | 并发与重复点击只留一份申请；互相申请不自动成好友 | PASS | 测试 + 生产 E2E |
| F03 | 删除好友 | PASS | 集成测试；私聊授权随之撤销 |
| F04 | 重新申请复用原私聊、历史保留 | PASS | 生产 E2E |
| F05 | 拉黑优先、提示不泄露拉黑、解除拉黑不自动恢复好友 | PASS | 生产 E2E |
| F06 | 举报与审核 | PASS（代码）/ 待配置（生产） | 集成测试通过；审核页 `/app/moderation` 只对 `KKCHAT_MODERATOR_SUBS` 里的人开放，生产上还没填，举报能提交但没人能审 |
| P01 | 网页 / App / SSE / 产品服务接口共用一个私聊权限入口 | PASS | `src/lib/access.ts`；测试覆盖用户接口、产品服务接口、离线重发与实时连接 |
| P02 | 对方资料只信账号中心 | PASS | `src/lib/projection.ts`；测试：第三人、备注都改不了对方公开资料，目录不可用时不伪造用户 |
| L01 | 升级前已有的私聊继续可用 | PASS | 迁移给已有 DIRECT 会话写 LEGACY 授权；集成测试 + 带旧数据的本地库迁移验证；生产迁移成功 |
| M01 | 先落库再确认；`clientMessageId` 幂等 | PASS | 测试 + 生产 E2E |
| M02 | 实时送达、已读回执 | PASS | 生产网页录屏；原生 E2E |
| M03 | 断线补拉（按 seq）、超过 100 条分页 | PASS | 集成测试；按 seq 补拉另有生产 E2E |
| M04 | 附件鉴权（非成员拿不到） | PASS | `test/sync-attachments.test.ts` |
| A01 | 原生登录：public client + PKCE S256 + 系统浏览器 + 一次性换票 | PASS | 生产 E2E（Android / iOS 两个 client） |
| A02 | 错误 verifier、重放、过期被拒 | PASS | 生产 E2E + 测试 |
| A03 | 刷新轮换；旧刷新凭证重放视为泄露，只撤销这一台设备 | PASS | 生产 E2E |
| A04 | 账号中心退出 → KKChat 设备会话 60 秒内失效 | PASS | 生产实测 22 秒 |
| A05 | 多账号隔离 | PASS（服务端）/ NOT_VERIFIED（App 切号 UI） | 设备会话按 sub 隔离；App 内切换需真机 |
| R01 | Android release APK 构建、v2/v3 签名 | PASS | `apksigner verify` |
| R02 | 官网直链公开下载，整包哈希一致 | PASS | 发布脚本整包 GET 校验；独立再下载核对 |
| R03 | 产品中心卡片与下载页读同一份发布元数据 | PASS | `/api/releases/latest` → Platform Releases |
| R04 | App 内检查更新、下载、校验签名后安装 | NOT_VERIFIED | 代码与单测在；需要能装 APK 的设备 |
| R05 | Android 真机安装 / 首次启动 / 登录 | NOT_VERIFIED | 无设备、无可用模拟器 |
| D01 | Duo 铰链布局（单屏 / 横跨 / 旋转） | PASS（单测）/ NOT_VERIFIED（设备） | `apps/mobile/test/core.test.ts` 按 Duo 2 几何 |
| D02 | Duo 键盘弹出时布局 | NOT_VERIFIED | 需真机 |
| I01 | iOS 工程生成 | PASS（仅在 Linux 上 prebuild） | 生成目录不提交 |
| I02 | iOS 模拟器构建 / 签名 / 真机 / TestFlight / App Store | BLOCKED | 无 macOS、无 Apple Developer 账号 |
| N01 | 推送：APNs / FCM / 无 GMS 厂商通道 | BLOCKED | 只有设备 token 登记接口和 App 在前台时的本地通知 |
| W01 | 网页中英文切换 | PASS | 录屏；`kkchat_lang` |
| W02 | 网页窄屏 / 桌面布局 | PASS | 本地生产构建 + 生产截图（见 10.3） |
| X01 | 中国大陆网络下访问吉隆坡服务 | NOT_VERIFIED | 没有大陆测试点 |
| O01 | 发布与重启时的不可用时间 | PASS | 从约 90 秒降到约 0.6 秒，SSE 自动重连补拉（见 8.4） |

## 2. 仓库、分支、PR

| 仓库 | 分支 | 最新提交 | PR | 生产 |
|---|---|---|---|---|
| kkchat | `cursor/kkchat-global-friends-mobile-6046` | 本报告所在提交 | <https://github.com/yydsxwh/kkchat/pull/5> | `fcd8952`（含本报告之前的全部代码） |
| account | `cursor/kkchat-native-clients-6046` | `7123036` | <https://github.com/yydsxwh/account/pull/31> | `7123036` |
| platform | `cursor/kkchat-installers-6046` | `5a22852` | <https://github.com/yydsxwh/platform/pull/20> | `5a22852` |
| Andyyyds | `cursor/kkchat-product-center-6046`（基于 `Andyyyds20260901independentpackage`） | `0bdfb2c` | <https://github.com/yydsxwh/Andyyyds/pull/81> | `0bdfb2c49601` |
| infra | `cursor/kkchat-global-mobile-6046` | 部署脚本 | <https://github.com/yydsxwh/infra/pull/15> | 只在构建机执行 |

所有 PR 均未合并。生产跑的是这些分支上的提交；合并时请按仓库顺序：platform → account → kkchat → Andyyyds → infra。PR #4（多账号标签页）已并入 kkchat 分支，开关 `MULTI_ACCOUNT_TABS` 默认关闭，与生产原行为一致。

## 3. 好友规则

- 一对用户（两个 OIDC `sub`）只有一条关系。写操作先对这一对加 PostgreSQL advisory lock，再读状态、写状态，并发点击不会产生两份申请或两条好友关系。
- 申请：附言最多 120 字；30 天未处理自动过期；被拒绝后 24 小时内不能再申请；对方已向我申请时，我再申请返回「对方已申请」，由我同意，不自动成为好友。
- 查找：KK 号、账号（username）精确匹配；昵称模糊匹配。三种方式各自受对方隐私开关控制，另有「不接受好友申请」开关。查找、申请、发送都有按人限速。
- 二维码 / 邀请链接：`/i/<token>`，7 天有效，可撤销；链接里只有随机 token，没有 sub、邮箱或任何凭证。
- 拉黑优先于一切：被拉黑后对方发不出消息，提示与「还不是好友」相同，不暴露拉黑；解除拉黑不恢复好友。
- 私聊权限只有一个入口（`directAccess`）：拉黑 → 否；好友 ACTIVE → 是；否则看显式授权 `DirectGrant`（LEGACY：升级前已存在的私聊；BUSINESS：产品业务会话）。删除好友、拉黑会撤销授权。网页、App、SSE、`/api/service/*` 都走它。
- 规则里没有国家、地区、手机区号、IP、语言。

## 4. 旧聊天兼容

迁移 `20261024150000_global_friends_mobile` 只增不删：按时间给旧消息回填会话内序号，按 `lastReadAt` 换算已读游标，给每个已有 DIRECT 会话写一条 LEGACY 授权。所以升级前能聊的两个人，升级后不需要先加好友也能继续聊；删除或拉黑后授权才撤销。没有删除或改写任何旧消息。

## 5. 原生登录契约

- 账号中心登记两个 **public** client：`kkchat-android`、`kkchat-ios`，只允许 `authorization_code` + PKCE S256，回调只有一个精确地址 `https://kkchat.yydsxwh.com/native/auth/callback`（由 KKChat 域名控制，App Links 校验）。登记脚本：account `scripts/ensure-kkchat-native-clients.ts`，幂等。
- 流程：App 调 `POST /api/native/v1/auth/start`（带 code_challenge）→ 系统浏览器打开账号中心 → 回调页 302 到 `kkchat://auth/callback`，只带 `code` / `state` / `error` → App 调 `POST /api/native/v1/auth/exchange`（带 transaction secret 与 verifier）。KKChat 服务端换 token、校验 ID token 的 iss / aud / nonce / sid，建立 **KKChat 自己的设备会话**；账号中心的 token 不进 App。
- 设备会话：聊天凭证 15 分钟，刷新凭证 30 天、单次使用，设备会话最长 180 天。网络重试用同一个 `requestId` 拿回同一结果；旧刷新凭证换个 `requestId` 重放视为泄露，只撤销这一台设备。
- 撤销：KKChat 每 30 秒问账号中心内部接口 `POST /api/internal/sessions/status`，账号中心退出或撤销 `sid` 后，对应网页会话与设备会话失效并断开 SSE。生产实测 22 秒。
- 切换账号：`prompt=login` 强制重新认证；旧版（没有 `sid`）登录也会被要求重新认证。登录页支持 `ui_locales`（中 / 英）。
- 凭证去向：`ACCOUNT_CLIENT_SECRET`、服务 token、数据库凭证、签名私钥只在服务器环境变量或 Secrets 里；APK、JS bundle、二维码、下载元数据里都没有。

## 6. 消息可靠性

会话内序号用行锁分配（不跳号、不重复）；消息先提交事务再回 ACK；`clientMessageId` 幂等；已读游标只前进；按序号向前分页，单页最多 100、可一直翻；每个用户一条递增的同步序号，SSE 每个事件带 `id: seq`，断线后 `GET /api/sync?since=` 补拉（单页最多 500，保留 30 天，过旧要求全量对齐）。附件存私有目录，按文件头识别类型，最大 20 MB，读取时校验会话成员身份，孤立文件 24 小时后清理。

## 7. 接口

网页与 App 共用：`/api/conversations`、`/api/conversations/[id]`、`.../messages`、`.../read`、`.../attachments`、`.../presence`、`/api/messages/[id]/recall`、`/api/friends`、`/api/friend-requests`、`/api/friend-requests/[id]/[action]`、`/api/blocks`、`/api/directory`、`/api/invites`、`/api/invites/[token]`、`/api/users/[sub]`、`/api/me`、`/api/me/privacy`、`/api/reports`、`/api/sync`、`/api/realtime`、`/api/releases/latest`。原生专用：`/api/native/v1/auth/{start,exchange,refresh,logout}`、`/api/native/v1/sessions`、`/api/native/v1/push`。网页用 HttpOnly Cookie + CSRF；App 用 `Authorization: Bearer`，长期凭证不进 URL。

## 8. 生产部署记录（吉隆坡）

香港旧机器没有连接、没有改动。所有连接走 `infra/deploy/lib/my-prod-ssh.sh`（`MY_PROD_*`、固定 `known_hosts`）。

### 8.1 部署顺序与备份

| 时间 | 服务 | 版本（上一版） | 备份 | 回滚 |
|---|---|---|---|---|
| 10-24 23:38 | Account | `7123036`（`fa6cccb`） | `/var/backups/account/prod-before-7123036-20261024T153848Z.db`（`integrity_check` ok） | `infra/deploy/ship-account-release.sh --rollback` |
| 10-24 23:39 | Platform | `5a22852`（上一版 `server.js`） | `/opt/kemiao-platform/server.js.before-5a22852-20261024T153941Z`、`RELEASE_SHA.before-…` | 把 `.before-…` 两个文件拷回并重启 |
| 10-24 23:46–23:51 | KKChat | `defa6bc`（`a480175`） | `/var/backups/kkchat/kkchat-before-defa6bc-20261024T154604Z.dump`、`…-resolve-20261024T155034Z.dump`（`pg_restore --list` 校验）；nginx 配置 `nginx-kkchat.yydsxwh.com.20261024T155105Z` | `deploy/deploy-kkchat.sh --rollback` |
| 10-25 00:07–00:09 | Android 1.0.0 | 上传安装包、登记 Platform 发布 `rel_88982ebb75a4428bb09b29d0b030a9a6` | — | 发布新版本；不覆盖已发布版本 |
| 10-25 00:20 | 主站 | `79b5a152db5c`（`3686fed59ecb`） | `/var/backups/yyds/main-before-79b5a152db5c-20261024T161947Z.db` | `infra/deploy/ship-main-release.sh --rollback` |
| 10-25 01:35 / 01:45 / 01:49 | KKChat | `89af5bf` → `6909542` → `fcd8952`（网页修正、退出修正、帮助链接） | 每次 `kkchat-before-<sha>-<UTC>.dump` | 同上 |
| 10-25 01:52 | 主站 | `0bdfb2c49601`（`79b5a152db5c`） | `/var/backups/yyds/main-before-0bdfb2c49601-*.db` | 同上 |

账号中心在 23:38 之后用登记脚本建了 `kkchat-android`、`kkchat-ios` 两个 public client。

### 8.2 KKChat 迁移：P3018 的处理

第一次 `migrate deploy` 在 `20261012120000_tab_accounts` 报 P3018（`KkDevice` 已存在）：这几张表此前已在生产建好，但 `_prisma_migrations` 里没有记录。逐列对比确认与迁移文件一致后，执行 `prisma migrate resolve --applied 20261012120000_tab_accounts`，再 `migrate deploy` 成功应用 `20261024150000_global_friends_mobile`。全程没有 `migrate reset`、`db push`，没有删库或删消息；处理前后各有一份 `pg_dump`。

### 8.3 事故：主站约 1.5 分钟不可用（10-25 00:19:51 – 00:21:18）

主站发布脚本的 PM2 切换命令放在 admin 用户的单引号子 shell 里，远端变量没有展开，PM2 被指到 release 父目录，`npm start` 找不到 `package.json`，探活失败后的自动回滚也用了同一条命令。手动把 PM2 指回 `3686fed59ecb` 后恢复（00:21:18），之后修正脚本（infra `2163377`：切换命令只接受本地已知的字面目录名）并成功切到 `79b5a152db5c`。数据库没有受影响。

之后把产品页的「帮助与反馈」从一个未经确认的邮箱改为官网「联系我们」页（Andyyyds `0bdfb2c`），10-25 01:52 用修好的脚本完整发布了一次主站：`0bdfb2c49601`（上一版 `79b5a152db5c`），备份 `main-before-0bdfb2c49601-*.db`（`integrity_check` ok，权限 600），探活正常。

### 8.4 本轮修正

- **重启要等 90 秒**：Next 收到 SIGTERM 后等所有连接结束，SSE 不会自己结束，systemd 等满 90 秒才 SIGKILL，期间所有请求失败——之前每次发布都有这段空窗。现在实时层在退出时主动结束 SSE（客户端 3 秒后重连并按 seq 补拉），8 秒后仍未退出就强制退出，unit 的停止超时设为 20 秒兜底。生产实测：`systemctl restart` 0.04 秒返回，0.57 秒后探活就绪。
- **发布脚本**：standalone 产物会带上构建机的 `.env`，现在发布前删掉（生产只读 `/etc/kkchat.env`，三项关键配置在生产都有，Cookie 一直是 `Secure`）；`/etc/kkchat.env` 是 `640 root:kkchat`，脚本原来不带 sudo 去 grep，失败后每次追加一行重复配置——已改为 sudo，并把生产上重复的两行去重（去重前备份 `/var/backups/kkchat/kkchat.env.before-dedupe-*`）；版本目录统一为可读，下次 rsync 能复用线上文件，只传变化的部分；切换后必须看到 unit 指向新版本、探活返回新版本号，才算成功。
- **备份权限**：Account 与主站的 SQLite 备份原来是 `644`，已改成 `600`，脚本改为先建 `600` 空文件再写入。
- **网页**：桌面宽度下中文导航被挤成一字一行、英文导航压到会话标题上；右侧资料栏在没点资料时一直显示「加载中」；标记已读失败会把会话关掉。都已修复并上线。

## 9. Android

| 项 | 值 |
|---|---|
| 包名 | `com.yydsxwh.kkchat` |
| 版本 | 1.0.0（versionCode 1），minSdk 26（Android 8.0），targetSdk 36 |
| ABI | `arm64-v8a`、`armeabi-v7a`（真实手机与 Duo 都是 ARM） |
| 大小 | 48,920,926 字节（46.7 MB） |
| SHA-256 | `3a625225563695515a8d7768bfb55d7f4227c859e1e6eb32b962d313072d9a6a` |
| 签名证书 SHA-256 | `C1:A7:C4:12:89:FF:00:03:15:E9:12:15:B4:97:59:33:54:38:A5:6E:82:48:D8:48:AF:21:ED:DF:B9:C3:68:B9`（v2 + v3） |
| 构建提交 | `959d88a` |
| 下载 | <https://kkchat.yydsxwh.com/downloads/android/kkchat-1.0.0-1.apk>（元数据同目录 `kkchat-1.0.0-1.json`） |
| App Links | <https://kkchat.yydsxwh.com/.well-known/assetlinks.json> 指向上面的包名与证书 |

- 签名私钥只在 Secrets 里（`KKCHAT_UPLOAD_*`），构建时由 config plugin 读环境变量；缺任何一项 release 构建直接失败。仓库、APK、元数据里都没有私钥。
- 发布流程：`apps/mobile/scripts/build-android-release.sh` 产出 APK / AAB 与 `release.json`；上传到 `/var/www/kkchat-downloads/android/`；在生产机执行 `scripts/publish-android-release.mjs`：核对本地文件与元数据哈希 → 用公开地址整包下载再核对哈希 → 存入 Platform `app-installers` → 登记并发布 `kkchat` STABLE 版本。已发布的版本不能被覆盖，只能递增版本。
- App 内更新：读 `/api/releases/latest`，下载到 App 私有目录，确认 SHA-256 与发布元数据一致、包名相同、签名者与已安装版本相同、版本号更高，才交给系统安装器；需要用户允许「安装未知应用」。代码与单测在，设备上 NOT_VERIFIED。
- 已知问题：1.0.0 的「我的 → 帮助」显示 `support@yydsxwh.com`。域名有阿里云企业邮箱 MX，但这个邮箱是否存在没有核实。下一版改为打开官网「联系我们」页（代码已改）。如果这个邮箱确实存在，1.0.0 不需要处理；不存在请创建或在下一版发布后提示升级。

## 10. iOS、Duo、网页

### 10.1 iOS

Bundle ID `com.yydsxwh.kkchat`，部署目标 iOS 16.4，Associated Domains `applinks:kkchat.yydsxwh.com`。`/.well-known/apple-app-site-association` 在设置 `KKCHAT_IOS_APP_IDS`（`<TeamID>.com.yydsxwh.kkchat`）之前返回 404，避免发布一份写错 Team ID 的文件。

在 Mac 上继续的步骤：

1. `cd apps/mobile && npm ci && KKCHAT_VERSION_CODE=1 npx expo prebuild --platform ios`
2. `cd ios && pod install`，用 Xcode 打开 `KKChat.xcworkspace`，选 Team，跑模拟器。
3. 在 Apple Developer 建 App ID（开启 Associated Domains，需要推送时开 Push Notifications），在 KKChat 生产环境设置 `KKCHAT_IOS_APP_IDS` 后确认 AASA 返回 200。
4. Archive → App Store Connect → TestFlight；审核材料需要隐私政策与账号删除入口（App 里「我的 → 删除账号」打开账号中心）。

### 10.2 Surface Duo

原生模块（Kotlin）用 `WindowInfoTracker` 订阅 `WindowLayoutInfo`，把 `FoldingFeature` 的边界、方向、`isSeparating`、`occlusionType` 发给 JS。布局逻辑在 `apps/mobile/src/layout-core.ts`：横跨且铰链竖直时左右两栏（会话列表 | 聊天），两栏宽度按铰链两侧切分，内容不压在铰链上；铰链水平时上下两栏；单屏或普通手机走单栏；宽屏平板走双栏。键盘弹出时聊天栏用 `KeyboardAvoidingView`。

### 10.3 网页

<https://kkchat.yydsxwh.com/app>：会话、联系人（申请、加好友、我的二维码）、我的（资料、隐私、语言、拉黑名单、退出）；邀请落地页 `/i/<token>`；中英文。桌面三栏、≤960px 两栏、≤800px 单栏。

## 11. 用户怎么用

**国内用户**：打开 <https://www.yydsxwh.com/products/kkchat> → 网页版或下载 Android 版 →「使用账号中心登录」（手机号或邮箱）→「联系人 → 添加好友」输入对方 KK 号，或「我的二维码」让对方扫。

**海外用户**：同一入口；在登录框上方右侧切到 English，选 Email 注册 / 登录（不需要中国手机号或微信）→ 回到 KKChat → 按对方 KK 号添加。iPhone 暂时用 Safari 打开网页版。

**Android 安装**：用手机浏览器打开下载页 → 下载 → 允许浏览器「安装未知应用」→ 安装。以后在「我的 → 版本」检查更新。

## 12. 阻塞与需要补的配置

只列名称，不含任何值。凭证一律放 Cursor Secrets 或服务器环境变量，不要贴进代码、PR 或本报告。

| 阻塞 | 影响 | 需要什么、填在哪里 |
|---|---|---|
| 无 Apple Developer 账号 / 无 Mac | iOS 全部发布步骤 | Apple Developer Team ID、签名证书与描述文件（Xcode 自动管理即可）；KKChat 生产环境 `KKCHAT_IOS_APP_IDS`；一台 macOS 构建机或 EAS / Xcode Cloud |
| 无推送凭证 | App 在后台收不到新消息提醒 | APNs：`.p8` Key、Key ID、Team ID；FCM：Firebase 项目的 `google-services.json` 与服务账号；国内无 GMS 手机需要各厂商推送通道。都放 Secrets |
| 无邮件服务 | 海外用户找回密码 | 账号中心的发信配置（SMTP 或邮件 API）；domain 已有阿里云企业邮箱 MX，可用其 SMTP |
| 无 Android 设备 / KVM | 真机安装、App 内升级、扫码、多账号 UI | 一台 Android 8+ 真机，或带 `/dev/kvm` 的构建机 |
| 无 Surface Duo | 横跨、旋转、键盘的真机证据 | Duo / Duo 2 真机，或 Windows 上的 Duo 模拟器 |
| 无中国大陆测试点 | 跨境访问速度与可达性 | 大陆网络下的一台设备 |
| 国际手机号 | 海外用户只能用邮箱 | 需要国际短信服务商 |
| 没有举报审核员 | 举报能提交但没人处理 | 在吉隆坡 `/etc/kkchat.env` 加 `KKCHAT_MODERATOR_SUBS=<审核员的 usr_ sub，逗号分隔>` 后重启 `kkchat.service` |

## 13. 测试

| 范围 | 命令 | 结果 |
|---|---|---|
| kkchat（真实 PostgreSQL） | `npm test` | 52 / 52 通过 |
| kkchat | `npm run typecheck`、`npm run lint`、`npm run build` | 通过 |
| kkchat App | `cd apps/mobile && npm run typecheck && npm test` | 通过；8 / 8 |
| account | `npm test` | 14 / 14 通过 |
| platform | `npm test` | 187 / 187 通过 |
| Andyyyds | `npx tsc --noEmit`、`npx eslint packages/kkchat`、`npx tsx packages/kkchat/lib/releases.test.ts` | 通过 |
| 生产原生协议 E2E | 登录、换票重试、PKCE、查找、申请、SSE、幂等、补拉、已读、刷新轮换与重放、prompt=login、拉黑重加、撤销传播、退出 | 29 / 29 通过 |
| 生产网页 E2E（录屏） | 上海 ↔ 吉隆坡 加好友、聊天、已读、切中文 | 通过 |
| SIGTERM 退出 | 本地生产构建 + 生产重启 | 修复前 30 秒仍未退出；修复后 0.1 秒；生产重启 0.6 秒恢复 |
| 没跑 | Android / iOS 设备上的任何测试；Duo；推送；大陆网络 | 见第 12 节 |

## 14. 生产上留下的测试数据

账号中心里有三个邮箱注册的测试账号：「KKChat测试·上海」（KK 203）、「KKChat Test · Madrid」（KK 204）、「KKChat Test · Kuala Lumpur」（KK 205），它们之间有好友关系和几条测试消息。没有删除，方便你自己登录复现；不需要时在账号中心注销即可。
