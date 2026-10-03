# KKChat

公司的通讯产品。账号中心回答「谁是谁」，KKChat 回答「谁和谁在说话」。

主站、教务和以后的论坛、知识社区、商城都通过服务接口往这里发消息，不再各做一套私信表。跨产品身份只用账号中心的 `usr_xxx`。

## 本地

```bash
npm install
# 准备 PostgreSQL，并把 .env.example 复制为 .env
npx prisma migrate deploy
npm run dev
```

开发服务器监听 `0.0.0.0:3210`。生产进程只绑 `127.0.0.1:3210`，由 Nginx 转到 `https://kkchat.yydsxwh.com`。

## 环境变量

名字见 `.env.example`。`ACCOUNT_CLIENT_SECRET`、`ACCOUNT_INTERNAL_TOKEN`、`KKCHAT_SERVICE_TOKEN`、`KKCHAT_SESSION_SECRET` 只放服务器环境，不进前端，也不写进示例文件的值。

## 服务接口

其它产品的后端携带 `Authorization: Bearer <KKCHAT_SERVICE_TOKEN>` 和 `X-KKChat-Product: main|academic|...`：

- `POST /api/service/direct`
- `POST /api/service/messages`
- `GET /api/service/unread?accountSub=usr_...`

浏览器不能调用这些接口。客户端封装在 `@yydsxwh/shared` 的 `kkchat-client`。

## 旧主站聊天

主站 `ChatConversation` / `ChatMessage` 保持原样。`scripts/migrate-legacy-chat.ts` 默认只演练；对不上 `accountSub` 的记录会跳过。
