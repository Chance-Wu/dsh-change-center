# dsh-change-center

DeepSeek Harness 插件:文件变更的**捕获 → 审查 → 应用 → 回滚**中心。

> 范围(2025-08):专注变更的**应用与回滚**,并提供会话级批量操作(「全部应用」「全部回滚」+ Undo)。
> 审批(Approval)与拒绝(Reject)已移除——变更只有「应用」一条落盘路径,冲突/失败/想放弃时走 回滚 / 编辑 / 重新处理 收敛;
> AI 审查 / 风险 / 验证 / 策略(`allow|warn|deny`) / git / 历史 保留为审查辅助。
>
> **2.x「Vibe Flow」(2025-08)**:UI 重构为低干扰控制台 —— 默认第一屏是**当前 Turn 卡片**(Focus 极简 ⇄ Review 展开),
> Git/Review/Risk/Verification/History/Fix 全部收进 `··· / 更多`;风险只显示 ✓/⚠/⛔ 三级信号(不显示数字评分);
> 批量应用无风险一步到位 + toast **Undo**,有风险才给「⚠ … [查看] [仍然全部应用]」轻确认;AI Review 按需增强;
> 编辑器修改带**脏状态守卫**(未保存切换文件先三选:保存并切换/放弃并切换/取消);会话列表按 今天/昨天/更早 浏览,
> 自动跟随正在工作的 Turn;Issues 过滤器(全部/待处理/问题)。
>
> **3.x「Polish & Flow」(2025-08)**:不增加新能力,只收敛 —— Focus 状态卡只回答「有什么变化?要不要应用?」
> (状态行 + 风险文字行 + **[Review] [全部应用]**);Undo 是 5 秒倒计时的短生命周期操作;状态机收敛为单一事实源
> `models/ChangeState.ts`(host 转移表 + `actionsFor` + `statusMeta` 同源);Apply/Rollback 语义统一:
> **用户编辑 → Apply 直接写入编辑版**(新增 `diskBaseline` 已知磁盘状态,编辑器修改不再被误判为外部修改),
> 策略 deny 成为真正的单条 Guard(「仍然应用」= force);树行 hover 只显示主操作 + `···` 展开其余;
> More 面板按 智能分析/验证/开发/修复 分组默认折叠;测试转向 6 组行为契约(状态机 / Apply / Rollback / Batch / SSE / 黄金流程)。
>
> **5.x「Explain & Decide」(2025-08)**:降低理解成本 —— per-change AI 变更解释(为什么改/影响/建议,复用 AI 审查投影,零新增 LLM)、
> **Focus Diff** 模式(只显修改块+一句话)与**行号**、unified 行内 finding 标注、相关文件影响分析(点击切换)、文件导航(←/→)、
> 大文件折叠(>500 行渐进展开);流程收敛:编辑「**保存并应用**」一步落地、单文件应用即时 toast + 撤销、UI 去掉冗余按钮
> (「接受」「应用选中」),pending 主路径即「应用」。
>
> **4.x「Trust & Scale」(2025-08)**:从变更管理工具升级为 Agent 修改行为的可信控制层 ——
> **Change Timeline**(Focus 迷你时间轴 + 完整时间轴,复用 history 事件并关联文件路径);
> **Smart Snapshot 2.0**(内容寻址 blob 去重 + 无引用 GC,`snapshots/blobs/<hash>` + 每变更 marker,兼容旧布局回滚);
> **Large Repository Mode**(树搜索 / 操作 M-A-D 过滤 / 路径前缀过滤 + 平铺窗口化渲染,万文件不卡);
> **Conflict Center**(Agent 版本 vs 当前版本双栏对比 + 保留我的 / 采用Agent / 合并,`GET /changes/:id/current` · `POST /changes/:id/resolve`);
> **Agent Intent**(Focus 文件分解:「修改 N 个文件」展开逐文件 ✓/±);
> **Safe Apply**(`applyAll` 先 Prepare 预检全部再 Commit,`prepared` 计数);
> **Change Analytics**(轻量 7 天统计:文件数 / 成功率 / 回滚 / 高频修改文件,`GET /analytics`);
> **Git 写入**(Focus Git 面板手动 add / commit / push,仅显式用户操作,服务永不自动提交);
> 会话命名跟随 agent 标题(`session/title` 事件,存在时显示标题而非轮次);
> 全局 **UI 审美打磨**(Focus 卡渐变层级、头部分割线、操作条卡片化、toast 左色条、按钮质感、行 hover/选中过渡)。

## 功能

- **捕获**:监听 `tools/result`,把 `write`/`edit` 结果记为文件变更、`bash` 记为命令记录,自动按 agent turn 分组为变更会话;会话名优先取 agent 标题(`session/title` 事件),否则以「Turn N · HH:MM」命名(一次 turn = 一次 agent 回复周期内捕获的变更)。
- **Vibe UI(2.x / 3.x / 4.x)**:
  - 变更中心两个视图:**当前**(正在工作的 Turn 的 Focus 卡片,自动跟随,可「回到当前」)/ **会话**(按 今天/昨天/更早 分组的历史时间线,行内带一句话摘要)。
  - 会话面板 Focus 状态卡(摘要 + `✓ N files changed +X -Y` + 风险文字行 + `● Ready/AI 工作中` + **[Review] [全部应用]**;无待审时显示「✓ 已全部应用」;可展开 **Timeline** 与 **修改 N 个文件** 分解)⇄ Review 完整控制。
  - 会话头部自然语言摘要(单文件 → 单目录 → 双目录 → 混合,如「修改 src/auth 和 src/user 下 5 个文件」;host 随会话落库 `ChangeSession.summary`,客户端兜底共用同一实现 `models/sessionSummary.ts`);状态视觉按 V-8 表(applied=主成功、failed=突出、rejected/rolled_back=弱化,pending=○)。
  - **底部 Action Dock**:`N 个变更 · 已选 <文件>` + [↶ 回滚(有已应用时)] [✓ 全部应用](顶部只剩过滤 tabs);无风险一步到位 → toast `✓ N 个变更已应用 [Undo 5s]`;有风险(外部修改/策略 deny)→「⚠ N 个变更… [查看] [仍然全部应用(force)]」轻确认,不弹复杂对话框;批量先 **Prepare 预检**(冲突/deny 写盘前全部暴露,`prepared` 计数)再 Commit。
  - Issues 过滤器:**全部 / 待处理(pending+approved+failed)/ 问题**(问题 = 应用失败 ∪ 命中 error/critical 审查发现 ∪ 策略 deny 的变更)。
  - 逐变更风险标记:策略 deny 的变更行尾显示 **⛔**(`PolicyService.evaluateAll` 逐变更命中,`policy-evaluation` 接口返回 `hits`);冲突详情展示 `磁盘当前 hash ≠ 捕获时 hash`。
  - 键盘快捷键(输入框聚焦时不触发):`Cmd/Ctrl+K` 快捷键帮助浮层 · `Cmd/Ctrl+Enter` 应用当前 · `J`/`K`(`↑`/`↓`)上/下一个文件 · `A` 应用 · `U`/`Z` 回滚 · `M` 展开 AI 面板 · `Esc` 收起为 Focus。
  - DiffViewer(5.x):文件头 `+N -M` + 状态徽标(按状态语义着色)+ **行号**(统一视图 `before:after` gutter,并排左右行号);默认并排完整 diff,可切 **聚焦**(只显修改块+一句话)/统一/编辑;上方 **AI 变更解释卡**(为什么改/影响/建议 + 相关文件,无审查时给「运行 AI 审查」CTA);unified 行内 finding 标注(severity 色点);>500 行折叠渐进展开;脏状态弱视觉为文件名旁 `●`;样式全部收敛到 CSS Module。
  - 编辑器脏状态守卫:**保存后重算 before/after/diff,Apply 写入的一定是用户看到的版本**(`diskBaseline` 保证用户编辑不触发假冲突),未保存切换文件/会话先三选。
  - AI Review / Risk / Verification / Git / History / AI Fix 收进 `··· / 更多`,按 智能分析/验证/开发/修复 分组、默认折叠;风险默认只显示三级信号,不显示数字评分。
- **审查**:
  - 变更树:**默认目录树**(目录可折叠、行统计、全部展开/折叠),可切换「按扩展名 `*.ext`」分组(含聚合行数);路径为工作区相对路径;同一文件多次写入**只显示最新一次**(按路径去重);行悬停只显示**主操作**(应用/重试/回滚/重新处理);行尾状态字形(failed=!,applied=✓)+ deny ⛔。**4.x 大仓模式**:顶部搜索 / M-A-D 操作过滤 / 路径前缀过滤,目录树**平铺窗口化渲染**(固定行高 + 滚动窗口),万级变更不卡。
  - Diff 三/四模式(聚焦 / 统一 / 并排 / 编辑)+ 每变更操作栏:**应用**(pending、approved)、重试应用(failed)、回滚(applied)、重新处理(rejected、rolled_back)+ ←/→ 文件导航;按钮可用性由单一 `actionsFor` 矩阵驱动(源自共享 `models/ChangeState.ts`);编辑器「**保存并应用**」一步写入(冲突时提示查看差异处理)。
- **会话级批量操作**:「全部应用」(先 **Prepare 预检**——策略 + hash 守卫写盘前全部跑完,返回 `{applied, skipped, superseded, failed, blocked, prepared}`,superseded=被覆盖的旧写入、prepared=通过预检进入提交的待审数;`force` 时绕过 deny 门禁与外部修改守卫)、「全部回滚」(撤销全部已应用,返回 `{rolledBack, missing, failed}`,缺快照即无法恢复);批量结果以 toast 呈现,应用成功带 Undo 入口。
- **辅助**:Git 仓库信息与未提交文件列表(**Focus Git 面板可手动 add / commit / push**,commit 需消息、push 需二次确认,服务永不自动提交)、AI 审查(结构化 JSON findings,可按需运行,结果不改变变更状态机)、确定性风险规则(评分仅供内部,UI 只显示三级信号)、验证任务、策略门控(allow/warn/deny,**批量应用受 deny 拦截**,可 force)、历史时间线、设置导航「变更中心」分支图标。
- **后台任务**:验证 / AI 审查 / AI 修复 / 修复循环以 job 形式提交,HTTP 请求立即返回 `{job}`;客户端持有 `JobHandle {jobId, done, cancel}`,智能面板在任务运行中显示「取消」按钮、失败显示「重试」;`/events` SSE 流把变更/会话/job 事件推给浏览器,列表自动刷新、无需轮询。
- **持久化**:变更与会话落 `$DSH_HOME/change-center/store/*.jsonl`(含 `ChangeSession.summary` 摘要),历史落 `history/`,策略覆盖落 `policies.json`,**快照落 `snapshots/` —— 4.x 内容寻址:`blobs/<sha256>` 去重存储 + `changes/<session>/<changeId>/` 每变更 marker(回滚后即删;TTL 7 天 + 每 agent 会话保留最新 N + 无引用 blob GC;兼容旧布局回滚)**,**AI 审查结果落 `review/`、风险结果落 `risk/`** —— 全部经 `ctx.fs` 接缝(原子写),重启后数据保留;崩溃遗留的 active 会话重启时自动归为已完成;列表接口支持 `limit/offset` 分页(客户端会话列表带「加载更多」)。

## 架构

```
src/
├── capture/   ToolCapture —— tools/result → ChangeService.record
├── services/  ChangeService(状态机+存储,含 acceptAllAndApply(force)/rollbackAll) · SessionService · ApplyService(哈希守卫+原子写)
│              SnapshotService(快照/回滚) · DiffService(自研 LCS,大文件回退) · JsonlStore · JobService(后台任务) · pluginFs(沙箱策略)
├── git/       GitService(经 ctx.shell 查询,加 add/commit/push 写操作——仅显式调用)
├── verification/ · review/ · risk/ · history/ · policy/ · fix/ · loop/
├── api/       routes.ts —— /api/change-center 同源 REST + /events SSE(表格驱动路由)
└── client/    conversation.view「变更」标签页 + settings.section「变更中心」
               ChangeCenterSection(当前/会话双视图+自动跟随) · ChangeReviewPanel(Focus/Review+批量+toast/Undo+Issues过滤+脏状态守卫+Focus Git面板)
               · ChangeTree(目录/扩展名双视图,4.x 大仓模式:搜索+M-A-D/路径过滤+窗口化渲染) · DiffViewer(受控草稿,5.x:解释卡/Focus 模式/行号/行内标注/大文件折叠) · ReviewBar(文件导航+操作矩阵) · IntelligencePanel(收进「···/更多」)
               · RiskSignal(三级信号) · TimelineView(4.x 会话时间轴,迷你/完整) · summary(会话摘要) · statusMeta(状态视觉) · changeActions(操作矩阵单一事实源) · ErrorBoundary
```

变更状态机:`pending → applied → rolled_back`,以及 `approved` / `rejected` / `failed`
(历史兼容:`approved`/`rejected` 仅存在于旧记录,可应用/重新处理,新记录不再产生),
非法转移由状态模型直接拒绝(状态动作返回结构化错误,不抛 500)。

> **3.x 单一事实源**:转移表(`ChangeService` 的 `TRANSITIONS`)、操作矩阵(`actionsFor`)、
> 展示元数据(`statusMeta`)全部源自共享的 `src/models/ChangeState.ts` —— 任何组件都不能自行推断
> 「这个按钮该不该出现」。同路径最新变更按 `createdAt` + 记录序号稳定决出(同毫秒写入不产生歧义)。

## 变更操作矩阵(单一事实源 `actionsFor`,操作栏与目录树共用)

| 状态 | 应用 | 重试应用 | 回滚 | 重新处理 |
|------|:---:|:---:|:---:|:---:|
| `pending` | ✅ | — | — | — |
| `approved` | ✅ | — | — | — |
| `failed` | — | ✅ | — | — |
| `applied` | — | — | ✅ | — |
| `rejected` | — | — | — | ✅ |
| `rolled_back` | — | — | — | ✅ |

- **重新处理** = `rejected|rolled_back → pending`(`POST /changes/:id/repend`),消除死胡同。
- **全部应用** = 对每路径最新待审变更**直接应用**;非待审计入跳过、被覆盖的旧写入计入 superseded、策略 deny 计入 blocked(`?force=1` 时绕过 deny 门禁与外部修改守卫)。
- 批量进行中/结果展示/编辑器有未保存修改期间,面板锁定:操作栏、目录树快速操作、编辑器保存全部禁用;结果以 toast 呈现,应用成功带 Undo(即「全部回滚」),6 秒后自动消失。

## 操作速览（主路径：看 → 决定 → 落地）

| 目标 | 操作 | 反馈/回滚 |
|---|---|---|
| 快速应用全部 | 底部 Dock「✓ 全部应用」 | toast + 5s 撤销（= 全部回滚） |
| 应用单个文件 | 文件行/操作栏「应用」（pending 直接落盘） | toast「✓ 已应用」+ 撤销 |
| 编辑后落地 | 编辑模式改文本 →「保存并应用」（一步） | 冲突时提示查看差异处理 |
| 撤销/回滚 | 应用后「回滚」/ toast 撤销 /「全部回滚」 | 快照恢复 |

> **主路径 = 应用**：pending 可直接「应用」；**接受(approve)与拒绝(reject)操作已整体移除**(端点/方法/UI),
> `approved` / `rejected` 状态仅供历史兼容(旧记录仍可应用/重新处理)。

## 开发

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run(含 e2e:真实 write 工具 + 真实文件系统)
pnpm build       # tsc + tsdown(浏览器半边打包 lib/client.js)
```

> 测试将 `$DSH_HOME` 指向临时目录,持久化写入可写区域(与 DSH 沙箱兼容)。
> 当前测试基线:**188 个用例 / 24 个文件**(含真实 HTTP 路由集成测试 `routes-e2e.spec.ts`、行为契约 `contracts.spec.ts`)。
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
| `POST /changes/:id/{apply,rollback,edit,repend}` · `GET /changes/:id/current` · `POST /changes/:id/resolve` | 状态机操作(`apply?force=1` 绕过外部修改守卫;`edit` 需 body `{after}`;`repend` 重新处理 rejected/rolled_back;`current`=磁盘当前版本,`resolve`=写入用户选择的版本——冲突中心) |
| `GET /sessions` · `GET /sessions/:id[/changes]` | 变更会话 |
| `POST /sessions/:id/accept-all-apply` | **全部应用**:先 Prepare 预检(策略 + hash)再 Commit,返回 `{result:{applied,skipped,superseded,failed,blocked,prepared}}`(计数互斥:applied+failed+blocked=处理数,skipped=非待审,superseded=被覆盖的旧写入;`?force=1` 绕过 deny 门禁与外部修改守卫) |
| `POST /sessions/:id/rollback-all` | **全部回滚**:撤销本会话全部已应用变更,返回 `{result:{rolledBack,missing,failed}}`(缺快照即无法恢复) |
| `GET|POST /sessions/:id/git[/diff|log|status|add|commit|push]` · `GET /sessions/:id/verification` · `POST .../verification/run` | Git 与验证(`add` body `{paths?}`、`commit` body `{message}`、`push` body `{remote?,branch?}`,均为显式用户操作) |
| `GET|POST /sessions/:id/review[/run]` · `.../risk[/analyze]` | AI 审查与风险 |
| `GET /sessions/:id/history[/timeline]` | 历史时间线 |
| `GET /sessions/:id/policy-evaluation` | 当前会话变更命中的策略评估,返回 `{evaluations, hits}`(hits=逐变更命中,用于 ⛔ 标记与 Issues 过滤) |
| `GET|POST /policies` · `POST /policies/:id/{update,delete}` | 策略管理 |
| `GET /sessions/:id/fix` · `POST /sessions/:id/fix/run` · `POST /sessions/:id/loop/run` | AI 修复与修复循环 |
| `GET /sessions/:id/jobs` · `GET /jobs/:id` · `POST /jobs/:id/cancel` | 后台任务查询与取消 |
| `GET /events` | SSE 事件流(统一模型:change.created/change.updated · session.created/session.updated/session.completed · job.started/job.settled,携带最小载荷) |
| `GET /analytics` | 4.7 轻量统计(7 天窗口):`{analytics:{files,applied,failed,successRate,rollbacks,topFiles}}` |

> 长任务(`verification/run`、`review/run`、`fix/run`、`loop/run`)提交后立即返回 `{ job }`,
> 客户端经 `JobHandle` 等待结果(`done`,由 `job.settled` SSE 事件驱动 + 低频轮询兜底)或取消(`cancel`);列表与面板刷新由 `/events` SSE 驱动,无高频轮询。

## 数据目录(`$DSH_HOME/change-center/`)

- `store/changes.jsonl`、`store/sessions.jsonl` —— 变更与会话(重启恢复)
- `history/<agentSessionId>/history.json` —— 生命周期事件
- `snapshots/blobs/<sha256>` —— 内容寻址 blob(4.2 去重);`snapshots/changes/<sessionId>/<changeId>/{blob,absent}` —— 每变更 marker(回滚后即删,TTL 7 天 + GC)
- `policies.json` —— 用户策略覆盖
