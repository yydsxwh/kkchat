# KKChat V1 反馈

状态以这次环境里真实跑过的检查为准。代码写完不等于生产可用。

## 1. 架构

- **Account** 仍是身份源。KKChat 只保存 `usr_xxx` 的公开投影：KK 号、username、昵称、头像、公开角色。
- **KKChat** 自己的 PostgreSQL 保存会话、成员、消息、已读和浏览器会话。同一对 `accountSub` 只有一个 `DIRECT` 会话，`directKey` 与谁先发起、从哪个产品发起无关。
- 用户页面是 Next.js。实时用 SSE，认证走 HttpOnly `kkchat_session`，不在 query 里放长期 token。数据库是事实源，进程内 realtime bus 只做加速，并留了 Redis adapter 的接口。
- 其它产品后端用 `Authorization: Bearer` 加 `X-KKChat-Product` 调用 `/api/service/direct`、`/api/service/messages`、`/api/service/unread`。浏览器拿不到这些凭证。
- 普通互聊只有站内实时和未读。`notifyWechat` 只给站长/教务这种官方发送打开。微信正文被截成最多 20 字。短信默认关闭。
- **Platform** 继续负责微信。KKChat 不保存公众号 secret。

## 2. 改了哪些仓库

| 仓库 | commit | PR |
|---|---|---|
| kkchat | `9b02843c15c6944d487674bc685e820eaf8d91ab`（报告在同分支后续提交） | https://github.com/yydsxwh/kkchat/pull/1 |
| shared | `9802a510e3e9a7cd7416cac3191c73039e586b85` | https://github.com/yydsxwh/shared/pull/14 |
| account | `cd908c1b034da47a9175a0fae9843b1b48e57542` | https://github.com/yydsxwh/account/pull/23 |
| Andyyyds | `8edf7a93ef3727f50a64afe4235f86bf6d355d21` | https://github.com/yydsxwh/Andyyyds/pull/61 |
| academic | `96d28a5ef72421a28dd3e98b0a16ad7fbf55f00d` | https://github.com/yydsxwh/academic/pull/46 |
| platform | `f575259359f958eb8dd0b4f90eec09f9dc530b8f` | https://github.com/yydsxwh/platform/pull/15 |
| infra | `a2f4bd2da10c449219c863410831afa8c5a1ee10` | https://github.com/yydsxwh/infra/pull/9 |

shared 这一支基于已发布的 `v0.10.0`（`217416c`），这样 Platform 升级时不会丢掉 Academic 模板字段校验。

## 3. 数据库和 migration

- 新库，PostgreSQL。schema 在 `prisma/schema.prisma`。
- 第一份 migration：`prisma/migrations/20261003120000_init`。只建表，没有改主站 SQLite，也没有 `migrate reset`。
- 这次环境没有 PostgreSQL，也没有连上生产库，所以 **migration 没有在生产执行**。状态：**NEEDS_CONFIG**。

## 4. OIDC client

状态：**NEEDS_CONFIG**。

代码约定：

- 名称：`KKChat`
- client_id：`kkchat`
- 类型：`confidential`
- PKCE：开启
- scope：`openid profile account.basic offline_access`
- redirect：`{KKCHAT_ORIGIN}/api/auth/callback`，必须 exact match

`account/scripts/ensure-kkchat-client.ts` 会创建或补齐这个客户端。已存在时不轮换密钥。这次没有连上生产账号库，所以不能写成已经登记成功。

## 5. 生产 URL

规划：`https://kkchat.yydsxwh.com`

这次没有 DNS、没有证书、没有 Nginx reload。状态：**BLOCKED / NEEDS_CONFIG**。本地开发服务器在 `http://127.0.0.1:3210` 能打开首页。

## 6. systemd

模板：`deploy/kkchat.service`

- 服务名：`kkchat.service`
- 用户：`kkchat`
- 目录：`/opt/kkchat/current`
- 环境文件：`/etc/kkchat.env`
- `PORT=3210`，`HOSTNAME=127.0.0.1`

生产没有安装。状态：**NEEDS_CONFIG**。

## 7. Nginx / HTTPS

模板：`deploy/nginx-kkchat.conf`，`server_name kkchat.yydsxwh.com`，反代 `127.0.0.1:3210`，关掉 proxy buffering，便于 SSE。

HTTPS 证书没有签发。状态：**NEEDS_CONFIG**。

端口选择依据是仓库里的服务清单，不是这台机器上的 `ss`：3000 主站、3001/3002 其它站点、3003 账号中心、3120 日事、4000 Platform、4100 Academic、4200 Knowledge。3210 不在这份清单里。上线前仍要在服务器上确认。

## 8. 主站入口

代码已接到门户：默认顺序是论坛 → KKChat → 知识社区。旧导航没有 KKChat 时会插到论坛后面，不改其它项的名称和排序。顶栏在原来的「消息」旁边增加 KKChat，旧消息入口还在。

本地用无头 Chrome 打开了 KKChat 首页，桌面和 390px 宽都能看到品牌、登录按钮和返回主站。主站本身这次没有在浏览器里点进生产导航。状态：KKChat 页面 **已在本地打开**；主站生产点击 **未验证**。

## 9. 两用户私聊

单元测试覆盖了：同一对账号只有一个 DIRECT、未读增加和清零、已读、幂等、两分钟撤回、非成员 403、实时事件不发给局外人。13 项测试通过。

没有两个真实账号，也没有 PostgreSQL，所以没有做「B 不刷新就看到 A 的消息，然后重启进程消息仍在」的在线实测。状态：**逻辑已测，在线两用户 NOT VERIFIED**。

## 10. Main → KKChat

用户管理增加了「发消息」。服务器用当前站长的 `accountSub` 和对方的 `accountSub` 调 KKChat。没有绑定的用户显示暂不能发。

主站 `tsc` 通过。没有配置 `KKCHAT_SERVICE_TOKEN`，没有对生产用户真正发出去。状态：**代码已接，在线 NOT VERIFIED**。

## 11. Academic → KKChat

学员档案和老师档案增加了「发消息」。没有 `accountUserId` 时显示「尚未绑定统一账号，暂不能发 KKChat」。

教务 `tsc` 通过。同样没有在线发出。状态：**代码已接，在线 NOT VERIFIED**。

同一对 sub 只会进一个 DIRECT，这件事在 KKChat 单元测试里通过：先用 `sourceProduct=main` 建会话，再用 `academic` 取到同一个 id，两条消息都在里面。

## 12. 微信通知

shared 和 platform 登记了 `KKCHAT_MESSAGE_RECEIVED`。字段只有 `senderName`、`excerpt`、`occurredAt`。默认路由：站内开、微信开、短信关。KKChat 只有 `notifyWechat: true` 的官方发送才会请求 Platform，而且摘要先截到 20 字。

Platform 地址、服务凭证和模板 ID 都没配。状态：**NEEDS_CONFIG**。没配时发消息不会失败，只是不发微信。

## 13. 旧聊天

主站 `ChatConversation` / `ChatMessage` / `ChatMessageRead` / `ChatMessageHide` 没有删，也没有做破坏性 migration。

仓库里没有 `DirectConversation`、`DirectMessage` 或 `owner-messages` 这套表。站长私信如果还在旧聊天表里，迁移脚本会按 `User.accountSub` 处理；对不上就跳过。

- KKChat：`scripts/migrate-legacy-chat.ts`，默认 dry-run
- 主站：`scripts/kkchat-migrate-chat.ts`，默认 dry-run，`--apply` 才调用 KKChat，仍然不删旧行

状态：旧数据保留 **已在代码上保证**；没有对生产 SQLite 做演练。

## 14. 这次实际跑过的检查

- kkchat：`npm test` 13 通过，`tsc`，`eslint`，`next build`
- shared：`npm test` 82 通过，`tsc`，`eslint`
- account：目录查询测试通过，`tsc`，新文件 `eslint`。没有跑账号中心全量测试，也没有对生产库执行登记脚本
- Andyyyds：门户测试通过，`tsc` 通过。用户管理文件里原有的 effect lint 仍在，不是这次新增的
- academic：`tsc` 通过，新文件 `eslint` 通过
- platform：改依赖前的测试 160 通过；补上事件样例后 `tsc` 通过
- 本地首页：`GET /` 200，`GET /api/health` 返回 `{"ok":true}`，未登录 `GET /api/conversations` 401，错误服务凭证 401，未配置登录会回到首页并提示「登录还没配好」
- 无头 Chrome 看了桌面首页、390px 首页，以及登录未配置提示。登录按钮是普通链接，点击等价于打开 `/api/auth/login`，该地址返回 307 到 `/?error=login-unconfigured`

## 15. 还没做

朋友圈、音视频、端到端加密、原生客户端、超大群、文件云盘都没有做。群只做了创建和文本消息的骨架。本地隐藏消息留到 V1.1。

## 16. 需要手工配置的项

下面每一项都还没在生产填过。

### 16.1 DNS

位置：域名服务商里 `yydsxwh.com` 的解析。

- 主机记录：`kkchat`
- 类型：A 或 AAAA，指向现在这台吉隆坡机器的地址
- 结果应能打开：`https://kkchat.yydsxwh.com`

### 16.2 证书

位置：现有证书签发流程（与 `account.yydsxwh.com` 同一套）。

- 增加主机名：`kkchat.yydsxwh.com`
- 签好后 Nginx 才能对这个 `server_name` 开 443。这次的模板只写了 80，443 沿用你们现有的证书片段，不要另造一套。

### 16.3 PostgreSQL

在 KKChat 那台机器上新建独立库，不要连主站 SQLite，也不要连 Academic 的库。

- 库名建议：`kkchat`
- 然后在 `/opt/kkchat/current` 执行：`npx prisma migrate deploy`
- 执行前先备份。这次 migration 是空库首建，没有改旧表。

### 16.4 `/etc/kkchat.env`

不要把值写进 Git。

| 变量 | 填什么 |
|---|---|
| `KKCHAT_ORIGIN` | `https://kkchat.yydsxwh.com` |
| `DATABASE_URL` | 上一节那个 PostgreSQL 连接串 |
| `KKCHAT_SESSION_SECRET` | 至少 32 位随机字符串 |
| `ACCOUNT_ISSUER` | `https://account.yydsxwh.com` |
| `ACCOUNT_CLIENT_ID` | `kkchat` |
| `ACCOUNT_CLIENT_SECRET` | 下一节脚本打印的那一次明文 |
| `ACCOUNT_REDIRECT_URI` | `https://kkchat.yydsxwh.com/api/auth/callback` |
| `ACCOUNT_SCOPES` | `openid profile account.basic offline_access` |
| `ACCOUNT_INTERNAL_BASE_URL` | `https://account.yydsxwh.com` |
| `ACCOUNT_INTERNAL_TOKEN` | 与账号中心现有 `ACCOUNT_INTERNAL_TOKEN` 相同 |
| `KKCHAT_SERVICE_TOKEN` | 新的随机字符串，主站和教务用同一份，或改用下面的分产品 JSON |
| `MAIN_SITE_URL` | `https://www.yydsxwh.com` |
| `KKCHAT_COOKIE_SECURE` | `true` |
| `PLATFORM_BASE_URL` | Platform 真正的地址；没有就留空 |
| `PLATFORM_SERVICE_TOKEN` | Platform 发给产品 `kkchat` 的服务凭证；没有就留空 |

可选：`KKCHAT_SERVICE_TOKENS={"main":"...","academic":"..."}`。一旦写了，每个产品必须用自己的凭证。

### 16.5 账号中心登记客户端

在账号中心服务器、账号中心仓库里：

```bash
KKCHAT_ORIGIN=https://kkchat.yydsxwh.com npx tsx scripts/ensure-kkchat-client.ts
```

- 若打印 `client_secret=...`：只把这一行写入 `/etc/kkchat.env` 的 `ACCOUNT_CLIENT_SECRET`，然后丢掉终端记录。
- 若打印 `already exists`：密钥没变。KKChat 服务器上必须已经有当初那份明文。没有的话，不要在脚本里轮换；到账号中心后台把该客户端的密钥重置一次，再写入 env。

后台页面如果要核对：账号中心 → 软件产品，找到 client_id `kkchat`。

- 名称：`KKChat`
- 类型：confidential
- PKCE：开启
- 首页：`https://kkchat.yydsxwh.com`
- 回调：`https://kkchat.yydsxwh.com/api/auth/callback`
- scope：`openid` `profile` `account.basic` `offline_access`

后台新建应用时可能会生成别的 client_id。KKChat 认的是 `kkchat`，所以用脚本，不用一个随机 id。

### 16.6 主站和教务

主站环境（PM2 `yyds-course` 使用的 env）：

- `KKCHAT_URL=https://kkchat.yydsxwh.com`
- `KKCHAT_INTERNAL_URL=http://127.0.0.1:3210`（与 KKChat 同机时）
- `KKCHAT_SERVICE_TOKEN=` 与 `/etc/kkchat.env` 里的一致

教务 `/etc/academic.env` 同样这三项。`KKCHAT_SERVICE_TOKEN` 不要写进前端或 `.env.example` 的值。

### 16.7 安装进程

```bash
sudo useradd --system --home /opt/kkchat --shell /usr/sbin/nologin kkchat
sudo mkdir -p /opt/kkchat/current
# 放入 next standalone 产物：server.js、.next、node_modules、prisma
sudo cp deploy/kkchat.service /etc/systemd/system/kkchat.service
sudo systemctl daemon-reload
sudo systemctl enable --now kkchat.service
```

Nginx：先 `ss -lntp | grep 3210` 确认没有别人占用，再把 `deploy/nginx-kkchat.conf` 放进现有站点配置，`nginx -t` 后 `reload`。不要 `restart` nginx。

### 16.8 微信模板

位置：Platform 配置中心 → 通知。

- key：`notifications.wechat.officialAccount.template.kkchatMessage`
- 值：公众号里已经审核通过的模板 ID
- 字段映射：`notifications.wechat.fieldMaps` 里给 `KKCHAT_MESSAGE_RECEIVED` 映射 `senderName`、`excerpt`、`occurredAt`
- 不要把完整聊天正文映射进去

短信不用为 KKChat 配。默认路由 `sms: false`。
