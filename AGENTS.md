<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 开发提示词与 GitHub 协作约定

- 默认工作流：ChatGPT 分析需求并编写 Markdown 开发提示词 → 保存并提交到对应 GitHub 仓库 → 用户将仓库、分支和文件路径交给 Cursor → Cursor 阅读任务、核对当前代码、执行并更新完成状态。用户明确指定其他流程时，以用户本次要求为准。
- 单产品任务保存到该产品仓库的 `docs/cursor-tasks/`；跨产品、统一支付、账号及公共能力协作任务的主文档保存到 `yydsxwh/platform` 仓库的 `docs/cursor-tasks/`，写明涉及仓库及各自职责，其他仓库可通过链接引用，避免维护多份冲突正文。
- 提示词使用含义明确的 Markdown 文件名；交付时提供 GitHub 文件链接、仓库、实际分支和路径。不要只将开发提示词留在聊天或下载附件中。没有写入权限时，如实说明尚未提交并提供可提交内容，不得宣称已保存。
- 编写任务时列出目标、范围、涉及仓库、实现要求、验收标准和必要的测试；部署要求及生产操作权限按用户已授权范围写明，保存提示词本身不代表授权部署或真实交易。
- 执行任务前读取本仓库 `AGENTS.md`、适用的子目录规则和用户指定的任务文档，并确认当前检出分支/提交包含该任务。核对最新实现，避免重复实现或把历史问题当作当前事实。
- 执行后更新任务文档中的状态、已完成项、验证结果、遗留问题；区分“已实现”“已测试”“已部署”，没有证据不得标记完成。
- 密钥、商户私钥、服务器密码、令牌以及客户隐私数据不得写进提示词、`AGENTS.md` 或 Git 提交；只记录配置项名称，通过 Secrets 或环境变量注入。
