# dsh-change-center

DeepSeek Harness 插件:文件变更的**捕获 → 审查 → 块级应用/回滚**中心。

> 范围:专注变更的**应用 / 回滚 / 块级操作**。审批(approve)与拒绝(reject)流程已整体移除——变更只有「应用」
> 一条落盘路径,冲突 / 失败 / 想放弃时走 **回滚 / 编辑** 收敛;AI 审查 / 风险 / 验证 / 策略(`allow|warn|deny`) / git / 历史
> 保留为审查辅助。UI 为低干扰控制台:Focus 状态卡(只回答「有什么变化?要不要应用?」)⇄ Review 完整控制;
> 批量操作一步到位 + toast **Undo**;风险只显示 ✓/⚠/⛔ 三级信号;变更状态机为单一事实源(`models/ChangeState.ts`)。

## 功能

- **捕获**:监听 `tools/result`,把 `write`/`edit` 结果记为文件变更、`bash` 记为命令记录,自动按 agent turn 分组为变更会话;会话名优先取 agent 标题(`session/title` 事件),否则以「Turn N · HH:MM」命名;**同一会话内对同一文件的多次写入自动合并为一条记录**(保留最初 before → 最新 after 的完整差异,只 diff 最新的)。
- **Qoder 风格块级操作**(diff 内逐块,默认视图):
  - 块与块之间用空行分隔,每块头部是**融入 diff 的操作栏**:Git 风格**行号区间标记**(`-起,数 +起,数`,如 `-1 +4`)+ **已应用 / 已撤销** 胶囊 + [编辑] [应用该块/撤销该块] 按钮 —— 不再使用浮动面板,操作按钮始终可见、随块滚动;
  - **应用该块 / 撤销该块**:只影响当前块,其余块保持不变(逐块接受);操作成功后**自动跳到下一个块**;点击任意块 = 设为当前块(高亮),键盘 ↑/↓ 也可跳转;
  - **编辑**:块内直接改代码 →「保存该块」写回文件(编辑即应用该块;撤销该块会丢弃其编辑);
  - 滚动时自动高亮容器顶部的块(滚到底部选中最后一块);块级写入带 `diskBaseline` 外部修改守卫(与整体应用一致);「应用 / 全部应用」写回时保留块内编辑,不会被原始 after 覆盖。
- **Diff 视图**:默认 **统一**(逐块操作),可切 **并排** / **编辑**;**所有模式显示行号**(统一:删除行 = 修改前行号、插入行 = 修改后行号;并排:左右双栏行号 + 中间竖向分割线;编辑:行号 gutter 随滚动同步);模式标签是**滑动胶囊**分段控件;文件头 `+N -M` + 状态徽标;上方 **AI 变更解释卡**(为什么改 / 影响 / 建议 + 相关文件);unified 行内 finding 标注;diff 默认完整展开、不折叠;脏状态弱视觉为文件名旁 `●`。
- **变更树**:默认**目录树**(目录可折叠、行统计、全部展开/折叠),可切「按扩展名 `*.ext`」分组;同一文件多次写入**合并为一条记录、只 diff 最新**(保留最初 before → 最新 after 的完整差异,同路径去重兜底);行悬停只显示主操作(应用/重试/回滚/重新应用);**大仓模式**:搜索 / M-A-D 操作过滤 / 路径前缀过滤 + 平铺窗口化渲染,万级变更不卡。
- **每变更操作栏**:应用(pending)、重试应用(failed)、回滚(applied)、重新应用(rolled_back)+ ←/→ 文件导航;按钮可用性由单一 `actionsFor` 矩阵驱动(源自共享 `models/ChangeState.ts`)。
- **编辑器脏状态守卫**:未保存切换文件/会话先三选(保存并切换 / 放弃并切换 / 取消);编辑模式「**保存并应用**」一步落地(`diskBaseline` 保证用户编辑不被误判为外部修改)。
- **视图与批量**:「当前」(正在工作的 Turn 的 Focus 卡片,自动跟随)/「会话」(按 今天/昨天/更早 分组的历史时间线);Focus 状态卡(摘要 + `✓ N files changed +X -Y` + 风险文字行,可展开 **Timeline** 与「修改 N 个文件」分解)⇄ Review 完整控制;底部 **sticky Action Dock**(跟随滚动、始终可见,附提示「文件已写入 · 应用=确认+检查」):「全部应用」(先 **Prepare 预检**——策略 + hash 守卫写盘前全部跑完,再 Commit,返回 `{applied, skipped, superseded, failed, blocked, prepared}`;**被覆盖的旧写入(superseded)应用后从存储移除**,不再堆积 pending)、「全部回滚」(返回 `{rolledBack, missing, failed}`,缺快照即无法恢复);批量结果 toast 呈现,应用成功带 **Undo** 入口;有风险(外部修改 / 策略 deny)→「⚠ N 个变更… [查看] [仍然全部应用(force)]」轻确认。
- **键盘快捷键**(输入框聚焦时不触发):`⌘/Ctrl+K` 帮助浮层 · `⌘/Ctrl+Enter` 或 `A` 应用当前 · `J`/`K`(`↑`/`↓`)上/下一个文件 · `U`/`Z` 回滚 · `M` 展开 AI 面板 · `Esc` 收起为 Focus。
- **审查辅助**:AI Review / Risk / Verification / Git / History / AI Fix 收进 `··· / 更多`;风险默认只显示三级信号,不显示数字评分;Issues 过滤器(全部 / 待处理 / 问题);策略 deny 的变更行尾显示 ⛔。
- **后台任务**:验证 / AI 审查 / AI 修复 / 修复循环以 job 形式提交,HTTP 立即返回 `{job}`;客户端经 `JobHandle` 等待/取消;`/events` SSE 把变更/会话/job 事件推给浏览器,列表自动刷新、无需轮询。
- **持久化**:变更/会话落 `$DSH_HOME/change-center/store/*.jsonl`,历史落 `history/`,策略覆盖落 `policies.json`,快照落 `snapshots/`(内容寻址 blob 去重 + 每变更 marker,TTL 7 天 + GC),AI 审查/风险结果分别落 `review/`、`risk/`;全部经 `ctx.fs` 接缝原子写,重启后数据保留;列表接口支持 `limit/offset` 分页。

## 架构

```
src/
├── capture/   ToolCapture —— tools/result → ChangeService.record
├── services/  ChangeService(状态机+存储,含 applyAllPending(force)/rollbackAll/applyHunk/editHunk) · SessionService
│              ApplyService(哈希守卫+原子写) · SnapshotService(快照/回滚) · DiffService(自研 LCS + diffHunks/applyHunks 块级重构)
│              JsonlStore · JobService(后台任务) · pluginFs(沙箱策略)
├── git/       GitService(经 ctx.shell 查询,add/commit/push 写操作——仅显式调用)
├── verification/ · review/ · risk/ · history/ · policy/ · fix/ · loop/
├── api/       routes.ts —— /api/change-center 同源 REST + /events SSE(表格驱动路由)
└── client/    conversation.view「变更」标签页 + settings.section「变更中心」
               ChangeCenterSection(当前/会话双视图+自动跟随) · ChangeReviewPanel(Focus/Review+批量+toast/Undo+Issues过滤
               +脏状态守卫+sticky Action Dock+Git 面板) · ChangeTree(目录/扩展名双视图,大仓模式)
               · DiffViewer(受控草稿:统一/并排/编辑,块操作栏融入 diff+行号区间标记+全模式行号+行内标注)
               · Segmented(滑动胶囊分段控件) · ReviewBar(文件导航+操作矩阵) · IntelligencePanel(收进「···/更多」)
               · RiskSignal(三级信号) · TimelineView(会话时间轴,迷你/完整) · summary(会话摘要) · statusMeta(状态视觉)
               · changeActions(操作矩阵单一事实源) · ErrorBoundary
```

变更状态机(应用↔回滚 4 状态):`pending → applied → rolled_back`,以及 `failed`(应用失败可重试);
回滚后可直接**重新应用**(`rolled_back → applied`),无中间态。`approved`/`rejected` 已随「接受/拒绝」流程整体移除,
旧持久化记录中的这两种状态不再有对应状态位。非法转移由状态模型直接拒绝(状态动作返回结构化错误,不抛 500)。

> **单一事实源**:转移表(`ChangeState.TRANSITIONS`)、操作矩阵(`actionsFor`)、展示元数据(`statusMeta`)
> 全部源自共享的 `src/models/ChangeState.ts` —— 任何组件都不能自行推断「这个按钮该不该出现」。
> 同一会话同路径的多次写入自动合并为一条记录(只 diff 最新);跨会话的同路径写入各自独立。

## 变更操作矩阵(单一事实源 `actionsFor`,操作栏与目录树共用)

| 状态 | 应用 | 重试应用 | 回滚 | 重新应用 |
|------|:---:|:---:|:---:|:---:|
| `pending` | ✅ | — | — | — |
| `failed` | — | ✅ | — | — |
| `applied` | — | — | ✅ | — |
| `rolled_back` | — | — | — | ✅ |

- **重新应用** = `rolled_back → applied`(回滚后直接再应用,替代旧 repend 中间态)。
- **全部应用** = 对每路径最新待审变更**直接应用**(同会话同路径已合并为一条);非待审计入 skipped、策略 deny 计入 blocked(`?force=1` 时绕过 deny 门禁与外部修改守卫);被覆盖的旧写入(superseded)应用后从存储移除。
- 批量进行中/结果展示/编辑器有未保存修改期间,面板锁定:操作栏、目录树快速操作、编辑器保存全部禁用;结果以 toast 呈现,应用成功带 Undo(即「全部回滚」),5 秒后自动消失。

## 操作速览(主路径:看 → 决定 → 落地)

| 目标 | 操作 | 反馈/回滚 |
|---|---|---|
| 快速应用全部 | 底部 Dock「✓ 全部应用」 | toast + 5s 撤销(= 全部回滚);旧写入自动清理 |
| 确认单个文件 | 文件行/操作栏「应用」(冲突/策略检查 + 登记) | toast「✓ 已应用」+ 撤销 |
| 逐块接受 | 统一 视图浮动面板「应用该块 / 撤销该块」 | 只影响当前块,操作后自动跳下一块 |
| 块内改代码 | 块上「编辑」→ 修改 →「保存该块」 | 写回文件;撤销该块丢弃编辑 |
| 编辑后落地 | 编辑模式改文本 →「保存并应用」(一步) | 冲突时提示查看差异处理 |
| 撤销/回滚 | 应用后「回滚」/ toast 撤销 /「全部回滚」 | 快照恢复 |

> **主路径 = 应用**:pending 可直接「应用」;**接受(approve)与拒绝(reject)操作已整体移除**(端点/方法/UI),
> `approved` / `rejected` 状态位也已移除——旧持久化记录中的这两种状态不再有对应状态位。

## 开发

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run(含 e2e:真实 write 工具 + 真实文件系统)
pnpm build       # tsc + tsdown(浏览器半边打包 lib/client.js)
```

> 测试将 `$DSH_HOME` 指向临时目录,持久化写入可写区域(与 DSH 沙箱兼容)。
> 当前测试基线:**197 个用例 / 24 个文件**(含真实 HTTP 路由集成测试 `routes-e2e.spec.ts`、行为契约 `contracts.spec.ts`)。
>
> **沙箱说明**(`src/services/pluginFs.ts`):插件自有状态(`$DSH_HOME/change-center/` 下 store/snapshot/history/policies 写入)经
> `ctx.fs.writeText(..., PLUGIN_STATE_POLICY)`(`danger-full-access`)写入;「应用/回滚/块级操作」的工作区写回经 `workspaceWritePolicy(change.cwd)`
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
| `POST /changes/:id/{apply,rollback,edit}` | 状态机操作(`apply?force=1` 绕过外部修改守卫;`edit` 需 body `{after}`) |
| `POST /changes/:id/hunk` | **块级操作**:body `{index, revert?, force?}` 应用/撤销单个 hunk;body `{index, lines, force?}` 块内编辑(`lines`=该块新写入行) |
| `GET /changes/:id/current` · `POST /changes/:id/resolve` | 冲突中心:读取磁盘当前版本 / 写入用户选择的版本 |
| `GET /sessions` · `GET /sessions/:id[/changes]` | 变更会话 |
| `POST /sessions/:id/apply-all` | **全部应用**:先 Prepare 预检(策略 + hash)再 Commit,返回 `{result:{applied,skipped,superseded,failed,blocked,prepared}}`(计数互斥;`?force=1` 绕过 deny 门禁与外部修改守卫) |
| `POST /sessions/:id/rollback-all` | **全部回滚**:撤销本会话全部已应用变更,返回 `{result:{rolledBack,missing,failed}}`(缺快照即无法恢复) |
| `GET|POST /sessions/:id/git[/diff\|log\|status\|add\|commit\|push]` · `GET /sessions/:id/verification` · `POST .../verification/run` | Git 与验证(`add` body `{paths?}`、`commit` body `{message}`、`push` body `{remote?,branch?}`,均为显式用户操作) |
| `GET|POST /sessions/:id/review[/run]` · `.../risk[/analyze]` | AI 审查与风险 |
| `GET /sessions/:id/history[/timeline]` | 历史时间线 |
| `GET /sessions/:id/policy-evaluation` | 当前会话变更命中的策略评估,返回 `{evaluations, hits}`(hits=逐变更命中,用于 ⛔ 标记与 Issues 过滤) |
| `GET|POST /policies` · `POST /policies/:id/{update,delete}` | 策略管理 |
| `GET /sessions/:id/fix` · `POST /sessions/:id/fix/run` · `POST /sessions/:id/loop/run` | AI 修复与修复循环 |
| `GET /sessions/:id/jobs` · `GET /jobs/:id` · `POST /jobs/:id/cancel` | 后台任务查询与取消 |
| `GET /events` | SSE 事件流(统一模型:change.created/change.updated · session.created/session.updated/session.completed · job.started/job.settled,携带最小载荷) |
| `GET /analytics` | 轻量统计(7 天窗口,`?window=0` 为全部历史):`{analytics:{files,applied,failed,successRate,rollbacks,topFiles}}` |

> 长任务(`verification/run`、`review/run`、`fix/run`、`loop/run`)提交后立即返回 `{ job }`,
> 客户端经 `JobHandle` 等待结果(`done`,由 `job.settled` SSE 事件驱动 + 低频轮询兜底)或取消(`cancel`);列表与面板刷新由 `/events` SSE 驱动,无高频轮询。

## 数据目录(`$DSH_HOME/change-center/`)

- `store/changes.jsonl`、`store/sessions.jsonl` —— 变更与会话(重启恢复)
- `history/<agentSessionId>/history.json` —— 生命周期事件
- `snapshots/blobs/<sha256>` —— 内容寻址 blob(去重);`snapshots/changes/<sessionId>/<changeId>/{blob,absent}` —— 每变更 marker(回滚后即删,TTL 7 天 + GC)
- `policies.json` —— 用户策略覆盖
