# dsh-change-center

DeepSeek Harness 插件:文件变更的**捕获 → 审查 → 拒绝 / 应用 → 回滚**中心。

> 范围(2026-08):专注**变更的接收、拒绝、回滚**,并提供会话级批量操作(「全部接收并应用」「全部拒绝」「全部回滚」)。
> 审批(Approval)与工作流(Workflow)已移除;AI 审查 / 风险 / 验证 / 策略(`allow|warn|deny`) / git / 历史 保留为审查辅助。

## 功能

- **捕获**:监听 `tools/result`,把 `write`/`edit` 结果记为文件变更、`bash` 记为命令记录,自动按 agent turn 分组为变更会话;会话以「Turn N · HH:MM」命名(一次 turn = 一次 agent 回复周期内捕获的变更)。
- **审查**:
  - 变更树:**默认目录树**(目录可折叠、行统计、全部展开/折叠),可切换「按扩展名 `*.ext`」分组(含聚合行数);路径为工作区相对路径;同一文件多次写入**只显示最新一次**(按路径去重);行悬停快捷操作:接受 / 拒绝 / 回滚(applied)/ 重新处理(rejected、rolled_back)。
  - 统一 diff 视图(纯文本 / 左右对照 / 编辑器)+ 每变更操作栏:接受 / 拒绝 / 应用(pending、approved)、重试应用(failed)、回滚(applied)、重新处理(rejected、rolled_back);按钮可用性由单一 `actionsFor` 矩阵驱动,编辑器可直接改后保存。
- **会话级批量操作**:「全部接收并应用」(批准全部待审并写回,返回 `{approved, applied, skipped, superseded, failed}`,superseded=被覆盖的旧写入)、「全部拒绝」、「全部回滚」(撤销全部已应用,返回 `{rolledBack, missing, failed}`,缺快照即无法恢复);面板带待审计数徽标与结果摘要(「×」或 6 秒后自动关闭)。
- **辅助**:Git 仓库信息与工作树状态、AI 审查(结构化 JSON findings)、确定性风险规则(评分+原因)、验证任务、策略门控(allow/warn/deny)、历史时间线。
- **后台任务**:验证 / AI 审查 / AI 修复 / 修复循环以 job 形式提交,HTTP 请求立即返回 `{job}`;客户端持有 `JobHandle {jobId, done, cancel}`,智能面板在任务运行中显示「取消」按钮(取消为正常终态);`/events` SSE 流把变更/会话/job 事件推给浏览器,列表自动刷新、无需轮询。
- **持久化**:变更与会话落 `$DSH_HOME/change-center/store/*.jsonl`,历史落 `history/`,策略覆盖落 `policies.json`,快照落 `snapshots/` —— 全部经 `ctx.fs` 接缝(原子写),重启后数据保留;列表接口支持 `limit/offset` 分页(客户端会话列表带「加载更多」)。

## 架构

```
src/
├── capture/   ToolCapture —— tools/result → ChangeService.record
├── services/  ChangeService(状态机+存储,含 acceptAllAndApply/rollbackAll) · SessionService · ApplyService(哈希守卫+原子写)
│              SnapshotService(快照/回滚) · DiffService(自研 LCS,大文件回退) · JsonlStore · JobService(后台任务) · pluginFs(沙箱策略)
├── git/       GitService(经 ctx.shell 只读)
├── verification/ · review/ · risk/ · history/ · policy/ · fix/ · loop/
├── api/       routes.ts —— /api/change-center 同源 REST + /events SSE(表格驱动路由)
└── client/    conversation.view「变更」标签页 + settings.section「变更中心」
               ChangeReviewPanel(批量操作+面板锁) · ChangeTree(目录/扩展名双视图) · DiffViewer · ReviewBar
               · changeActions(操作矩阵单一事实源) · ErrorBoundary(渲染出错可恢复)
```

变更状态机:`pending → approved → applied → rolled_back`,以及 `rejected` / `failed`,
非法转移由 `TRANSITIONS` 表直接拒绝(状态动作返回结构化错误,不抛 500)。

## 变更操作矩阵(单一事实源 `actionsFor`,操作栏与目录树共用)

| 状态 | 接受 | 拒绝 | 应用 | 重试应用 | 回滚 | 重新处理 |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| `pending` | ✅ | ✅ | ✅ | — | — | — |
| `approved` | — | ✅ | ✅ | — | — | — |
| `failed` | — | ✅ | — | ✅ | — | — |
| `applied` | — | — | — | — | ✅ | — |
| `rejected` | — | — | — | — | — | ✅ |
| `rolled_back` | — | — | — | — | — | ✅ |

- **重新处理** = `rejected|rolled_back → pending`(`POST /changes/:id/repend`),消除死胡同。
- **全部接收并应用** = 对每路径最新待审变更 先接受再应用(approve+apply);非待审计入跳过、被覆盖的旧写入计入 superseded。
- 批量进行中/结果展示期间,面板锁定:操作栏、目录树快速操作、编辑器保存全部禁用;结果摘要「×」关闭或 6 秒后自动消失后恢复(回滚等单条入口重新可用)。

## 开发

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run(含 e2e:真实 write 工具 + 真实文件系统)
pnpm build       # tsc + tsdown(浏览器半边打包 lib/client.js)
```

> 测试将 `$DSH_HOME` 指向临时目录,持久化写入可写区域(与 DSH 沙箱兼容)。
> 当前测试基线:**147 个用例 / 20 个文件**(含真实 HTTP 路由集成测试 `routes-e2e.spec.ts`)。
>
> **沙箱说明**(`src/services/pluginFs.ts`):插件自有状态(`$DSH_HOME/change-center/` 下 store/snapshot/history/policies 写入)经
> `ctx.fs.writeText(..., PLUGIN_STATE_POLICY)`(`danger-full-access`)写入;「应用/回滚」的工作区写回经 `workspaceWritePolicy(change.cwd)`
> (`workspace-write`,锚定变更的工作区)。`dsh-fs-sandbox` 后端据此放行,因此默认 `dsh web` 启动(workspace-write 模式)下
> 持久化与 apply 不再被会话文件围栏拒绝。覆盖 JsonlStore / SnapshotService / HistoryService / PolicyService / ApplyService。

### 接入 DSH

插件作为 profile bundle 接入:把本包加入 profile 的 `dsh.profile.bundles`(加载器会应用包内
`cordis.patch.yml` 的 `change-center` insert 行);包内 `dsh.client` manifest 声明浏览器半边
(`platform: web`),由 Harness web 前端自动纳入 `window.__DSH_BOOT__` 加载清单。
宿主半边经 `ctx.webServer.register({ kind: 'prefix', path: '/api/change-center' })` 挂载同源 REST 与 SSE。

## HTTP API(前缀 `/api/change-center`)

| 资源 | 说明 |
|------|------|
| `GET /changes` · `GET /changes/:id` | 变更列表 / 单个变更 |
| `POST /changes/:id/{approve,reject,apply,rollback,edit,repend}` | 状态机操作(`apply?force=1` 绕过外部修改守卫;`edit` 需 body `{after}`;`repend` 重新处理 rejected/rolled_back) |
| `GET /sessions` · `GET /sessions/:id[/changes]` | 变更会话 |
| `POST /sessions/:id/{accept-all,reject-all}` | 会话级批量接受/拒绝 |
| `POST /sessions/:id/accept-all-apply` | **全部接收并应用**:批准全部待审变更并写回,返回 `{result:{approved,applied,skipped,superseded,failed}}`(计数互斥:applied+failed=处理数,skipped=非待审,superseded=被覆盖的旧写入) |
| `POST /sessions/:id/rollback-all` | **全部回滚**:撤销本会话全部已应用变更,返回 `{result:{rolledBack,missing,failed}}`(缺快照即无法恢复) |
| `GET /sessions/:id/git[/diff|log]` · `GET /sessions/:id/verification` · `POST .../verification/run` | Git 与验证 |
| `GET|POST /sessions/:id/review[/run]` · `.../risk[/analyze]` | AI 审查与风险 |
| `GET /sessions/:id/history[/timeline]` | 历史时间线 |
| `GET /sessions/:id/policy-evaluation` | 当前会话变更命中的策略评估 |
| `GET|POST /policies` · `POST /policies/:id/{update,delete}` | 策略管理 |
| `GET /sessions/:id/fix` · `POST /sessions/:id/fix/run` · `POST /sessions/:id/loop/run` | AI 修复与修复循环 |
| `GET /sessions/:id/jobs` · `GET /jobs/:id` · `POST /jobs/:id/cancel` | 后台任务查询与取消 |
| `GET /events` | SSE 事件流(change:* / change-session:* / job:settled) |

> 长任务(`verification/run`、`review/run`、`fix/run`、`loop/run`)提交后立即返回 `{ job }`,
> 客户端经 `JobHandle` 等待结果(`done`,内部轮询 `GET /jobs/:id`)或取消(`cancel`),列表刷新由 `/events` SSE 驱动。

## 数据目录(`$DSH_HOME/change-center/`)

- `store/changes.jsonl`、`store/sessions.jsonl` —— 变更与会话(重启恢复)
- `history/<agentSessionId>/history.json` —— 生命周期事件
- `snapshots/<sessionId>/<changeId>/` —— 应用前快照(回滚后即删,TTL 7 天兜底)
- `policies.json` —— 用户策略覆盖
