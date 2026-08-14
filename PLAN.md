# dsh-change-center 优化计划

> 分析日期:2025-08-14 · 依据:源码通读 + 全量测试 + typecheck
> 质量基线:`tsc --noEmit` 通过;12 个测试文件 72 个用例,67 通过 / 5 失败(全部集中在 `tests/apply.e2e.spec.ts`);目录非 git 仓库、无 README、无 .gitignore。
>
> **范围决策(2025-08-14)**:移除插件的**审批(Approval)与工作流(Workflow)**及其直接耦合,专注**变更的接收、拒绝、回滚**;
> 其余智能服务(AI 审查 / 风险 / 验证 / 策略 / git / 历史 / AI 修复 / 修复循环)保留,作为拒绝决策与回滚的辅助信息。

---

## 执行状态(2025-08-14)

| 阶段 | 状态 | 说明 |
|------|------|------|
| Phase 0 范围裁剪 | ✅ 完成 | 审批/工作流全部移除,无残留;测试 72→59(移除 13 个相关用例) |
| Phase A 修复阻断 | ✅ 完成 | 持久化统一走 `ctx.fs`;History 映射修复;变更/会话 JSONL 落盘;**全量 63/63 通过**(新增 persistence/diff/edit 用例) |
| Phase B 加固 | 🟡 部分 | 已完成 B-1(diff 上限+回退)、B-4a(检测异步化)、B-5(快照回滚清理+TTL)、B-6(purpose/edit 语义/路径匹配);B-2 完成分页+body 上限+错误码,**表格驱动路由重构未做**;B-3(长任务后台化/取消)未做 |
| Phase C 体验/工程 | 🟡 部分 | 已完成 C-4(git init、.gitignore、README、CI workflow);C-1(事件驱动前端)、C-2(共享 wire 类型)、C-3(样式/文案统一)未做 |

> 遗留项:B-2 表格驱动路由、B-3 后台任务、C-1/C-2/C-3,以及 B 阶段其余小项——见下方案例清单,可在后续轮次继续。

---

## 一、现状与目标架构

### 1.1 当前架构

- **Host 半边**(`src/`):13 个 Service + 工具捕获 + 手写 HTTP 路由,按阶段分层:
  - 核心(P2):`ChangeService`(变更状态机 + 内存存储)、`SessionService`(每 turn 一个变更会话)、`ApplyService`(内容哈希守卫 + 原子写回)、`SnapshotService`(磁盘快照/回滚)、`DiffService`(自研 LCS diff);
  - 智能(P3):`GitService`、`VerificationService`、`AIReviewService`、`RiskService`、`ApprovalService`(将移除)、`HistoryService`;
  - 控制面(P4):`PolicyService`、`WorkflowService`(将移除)、`AIFixService`、`ReviewFixLoopService`。
- **Client 半边**(`src/client/`):`conversation.view` 槽的"变更"标签页 + `settings.section` 槽的"变更中心",共用 `ChangeReviewPanel`(文件树 + diff 查看器 + 审查栏 + 智能面板)。
- **通信**:Client 通过同源 `/api/change-center` REST 调 Host,无 RPC、无共享状态。

### 1.2 目标架构(精简后)

**核心主线(聚焦)**:变更接收 → 审查辅助 → 拒绝 / 应用 → 回滚

```
接收   ToolCapture(tools/result) → ChangeService.record → SessionService 分组 → DiffService 渲染
审查   辅助:AI 审查 / 风险 / 验证 / git / 历史 / 策略(allow | warn | deny)
操作   拒绝(change:rejected)→ 回滚(change:rollback);应用(apply)作为回滚的前提保留在状态机内部
```

**移除清单**(Phase 0 执行,见 3.1):

| 层 | 移除内容 |
|----|----------|
| 服务 | `src/approval/ApprovalService.ts`、`src/workflow/WorkflowService.ts` |
| 模型 | `ApprovalRecord`(Phase3);Phase4 全部 workflow 类型(`ChangeWorkflow`/`WorkflowStep`/`WorkflowStepState`/`WorkflowState`、step type `approval`) |
| 事件 | `approval:decided`、`workflow:status` |
| API | `routes.ts` 中 approval / workflow / policy-evaluation 的全部路由与 `Parsed` 分支 |
| Client | `WorkflowPanel.tsx`;`WireApproval`/`WireWorkflowState` 与 `approvalGet/approvalDecide/workflowGet/workflowAdvance/policyEvaluation`;IntelligencePanel 的 `ApprovalCard` 与 workflow 卡片;`i18n.ts` 的 `WORKFLOW_STEP_ZH`、`require_approval` 文案 |
| 策略 | `PolicyAction` 去掉 `require_approval`;删除 4 条内置 require_approval 策略(`sql-approval`/`dependency-approval`/`delete-approval`/`high-risk-approval`) |
| 测试 | `phase4-unit.spec.ts` 的 workflow 用例、`phase3-services.spec.ts` 的 approval 用例;policy 用例同步更新(require_approval 分支) |

**保留清单**:

- 核心:`ToolCapture`、`ChangeService`(状态机保留 `pending/approved/rejected/applied/failed/rolled_back`——approve/apply 是"接受 + 回滚前提"的内部机制,不构成审批中心)、`SessionService`、`ApplyService`、`SnapshotService`、`DiffService`。
- 辅助:`GitService`、`VerificationService`、`AIReviewService`、`RiskService`、`HistoryService`、`PolicyService`(仅 `allow|warn|deny`)、`AIFixService`、`ReviewFixLoopService`。
- Client:变更标签页 + 变更中心(`ChangeTree`/`DiffViewer`/`ReviewBar`/`IntelligencePanel` 去除审批与工作流卡片后保留)。

### 1.3 优点(应保持)

1. 分层清晰:models / services / engines / api / client 职责分明,`apply()` 只做组合。
2. 变更状态机用显式 `TRANSITIONS` 表约束,非法转移直接报错,可测试性好。
3. Apply 走 `ctx.fs.writeText`(staging + rename 原子写),外部变更用 SHA-256 哈希守卫。
4. 事件驱动:`change:*` / `change-session:*` 事件集完整,History 订阅自身事件落盘。
5. 测试覆盖面大(67 个通过用例,含 e2e 真实 write 工具 + 真实文件系统)。

### 1.4 阻断问题(5 个 e2e 失败根因)

`tests/apply.e2e.spec.ts` 全部失败,直接错误:

```
EPERM: operation not permitted, mkdir '/Users/chenyang/.dsh/change-center/snapshots/d1'
```

**根因**:`SnapshotService`、`HistoryService`、`PolicyService` 用裸 `node:fs/promises` 直接写 `$DSH_HOME/change-center/...`,
绕过 `ctx.fs` 这一受沙箱/审批约束的文件系统接缝。DSH 文件沙箱激活时(本环境即 workspace-write 模式),工作区外的写被拒绝(EPERM)。
apply 流程**先 snapshot 后写回**,snapshot 一步就炸,导致 5 个用例级联失败。
`ApplyService`/`SnapshotService` 的删除路径同样用了裸 `unlink`。

> 这同时是一个架构问题:持久化没有统一走 harness 的 fs 接缝,沙箱/审批/原子性保证在持久化层缺失。

---

## 二、问题清单(精简后)

### P0 — 阻断缺陷(必须修)

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| P0-1 | 持久化绕过 `ctx.fs`,沙箱下 EPERM | SnapshotService / HistoryService / PolicyService / ApplyService.delete / SnapshotService.delete | 5 个 e2e 失败;沙箱部署下 apply/rollback/history/policy 全不可用 |
| P0-2 | `change-session:created` 事件永不落盘 | HistoryService.ts:63 `sessionOf: sessionIdOf`,而 `ChangeSession` 没有 `sessionId` 字段 | 会话创建史缺失,时间线不完整 |
| P0-3 | 核心存储全在内存,重启即丢 | ChangeService / SessionService / AIReview / Risk / Verification / Fix | "变更中心"不是持久中心;host 重启后审查记录清空(范围:变更/会话/审查结果,不含已移除的审批/工作流) |

### P1 — 架构与健壮性

| # | 问题 | 位置 | 建议 |
|---|------|------|------|
| P1-1 | `purpose: 'session-title' as never` 类型 hack | AIReviewService.ts:100 / AIFixService.ts:128 | 用正确的调用分类,或去掉该字段 |
| P1-2 | 自研 LCS diff 为 O(n·m) 时间+空间 | DiffService.ts `computeLcs` | 大文件(lockfile、生成文件)可 OOM/卡 UI;加行数上限 + 回退,或换 Myers/现成 diff 库 |
| P1-3 | 手写路由解析器,if 链长、无分页、无体积上限 | api/routes.ts `parsePath` / `dispatch` | 表格驱动路由;list 接口加 limit/offset(或游标);POST body 设大小上限(裁剪后路由减少,重构成本更低) |
| P1-4 | 验证/审查/fix/loop 前台阻塞 | VerificationService `run`(120s)、AIReview、fix、loop | 转后台任务 + 状态轮询/事件推送;可取消 |
| P1-5 | `existsSync` 同步检测阻塞事件循环 | VerificationService.ts:64 | 走 `ctx.fs.stat` 异步化 |
| P1-6 | API 无鉴权/归属校验 | api/routes.ts | 任意同源页面可 apply/rollback/改策略;至少绑定 agent session 上下文 |
| P1-7 | 快照无 TTL/容量上限 | SnapshotService | 磁盘无限增长;加保留期/上限,rollback 与 session 完成时清理 |
| P1-8 | fix-loop 按 `path.endsWith` 匹配 finding 与 change | ReviewFixLoopService.ts:90 | 先解析为绝对路径再匹配 |
| P1-9 | 已应用变更被 `edit()` 静默改写 `after`,磁盘不同步 | ChangeService.edit | 明确语义:applied 状态禁止 edit,或 edit 后置 failed 强制重新走管线 |

### P2 — 体验与工程质量

| # | 问题 | 影响 |
|---|------|------|
| P2-1 | Client 轮询代替事件推送(ChangesTab 3s 轮询、Section 每次操作后全量刷新) | N+1 请求、UI 过期;应消费 `change:*` 事件流 |
| P2-2 | `WireChange`/`WireSession` 等 wire 类型手抄 host 模型 | 类型漂移风险;应共享/生成 |
| P2-3 | 样式不统一:内联 style 与 CSS Module 混用,PolicyPanel 无样式文件 | 维护成本;统一到 CSS Module + 设计 token |
| P2-4 | 无 README / 架构文档 / API 文档 | 上手成本;补 docs |
| P2-5 | 无 git 仓库、无 .gitignore、无 CI | 变更不可追溯;init + 忽略 node_modules,lib 是否入库需决策 |
| P2-6 | "session id" 词汇混乱:change-session.id / agentSessionId / history 键三套 | 易错;文档化或重命名 |
| P2-7 | fix/review/loop 无进度流与取消 | 分钟级操作零反馈;加进度事件 |
| P2-8 | AI review 一次拼接整会话 diff,无上限 | 大会话超 token;分块/抽样 |
| P2-9 | UI 文案硬编码简体中文(i18n.ts 为映射表) | 目标明确可接受;如需多语言再抽 locale |

---

## 三、分阶段实施计划

### Phase 0 — 范围裁剪:移除审批与工作流(先行,预计 0.5~1 天)

> 先裁剪再优化:移除后的代码量显著变小,后续 Phase 的重构面也随之缩小。

1. **删除服务与组件**:`src/approval/ApprovalService.ts`、`src/workflow/WorkflowService.ts`、`src/client/WorkflowPanel.tsx`。
2. **清理模型**:`Phase3.ts` 删 `ApprovalRecord`;`Phase4.ts` 删 workflow 类型,`PolicyAction` 去掉 `require_approval`。
3. **清理入口**:`src/index.ts` 移除两个服务的 import/挂载/type 导出,以及 `approval:decided`、`workflow:status` 事件声明。
4. **清理 API**:`routes.ts` 删除 approval / workflow / policy-evaluation 路由、`Parsed` 分支与 `dispatch` 分支;`src/client/index.ts` 删除 `WireApproval`/`WireWorkflowState` 与 `approvalGet/approvalDecide/workflowGet/workflowAdvance/policyEvaluation`。
5. **清理 UI**:`IntelligencePanel.tsx` 删除 `ApprovalCard`、workflow 状态与 `WorkflowPanel` 渲染;`i18n.ts` 删除 `WORKFLOW_STEP_ZH` 与 `require_approval` 文案。
6. **清理策略**:`PolicyService.ts` 删除 4 条内置 require_approval 策略,`PolicyAction` 类型同步收窄。
7. **清理测试**:删除/改写 `phase4-unit.spec.ts`(workflow 用例)、`phase3-services.spec.ts`(approval 用例)与 `phase3-unit.spec.ts` 中的相关用例;policy 用例去掉 require_approval 分支。
8. **验收**:`tsc --noEmit` 绿;`grep -riE 'approval|workflow' src tests` 无残留(注释说明除外);全量 `vitest run` 绿。

### Phase A — 修复阻断(P0,预计 1~2 天)

1. **A-1 持久化统一走 `ctx.fs` 接缝**
   - `SnapshotService` / `HistoryService` / `PolicyService` 注入 `fs`,用 `ctx.fs.resolve / stat / readText / writeText / processPath` 代替裸 `node:fs`;删除用 `fsio` 或 `processPath + unlink` 但须经接缝。
   - 根目录仍为 `$DSH_HOME/change-center/...`,所有读写过 fs 接缝,沙箱/审批/原子性一致。
   - 验收:本环境 `npx vitest run tests/apply.e2e.spec.ts` 全绿;整体 72/72 通过。
2. **A-2 修 HistoryService 会话创建事件映射**
   - `change-session:created` 的 `sessionOf` 改为读 `args[0].id`(或 `agentSessionId`)。
   - 验收:测试补充断言"会话创建事件进入时间线"。
3. **A-3 核心存储持久化(最小可行)**
   - 变更与会话落 JSONL(`$DSH_HOME/change-center/store/`),启动时加载;AIReview/Risk/Verification/Fix 结果随会话序列化(不含已移除的审批/工作流状态)。
   - 或评估 DSH 是否已带嵌入式 DB(sqlite 服务),有则优先复用。
   - 验收:重启后 settings 区仍能看到历史会话与变更。

### Phase B — 加固核心流程(P1,预计 2~3 天)

4. **B-1 diff 引擎加固**:行数上限(如 5k 行)超出走"前后文截断 + 计数"回退;评估换 Myers 或复用现成 diff 依赖。
5. **B-2 路由重构**:表格驱动匹配;list 分页;POST body ≤ 1MB;错误码统一(裁剪后仅剩 接收/审查/操作 三类路由,结构更清晰)。
6. **B-3 长任务后台化**:verification/fix/loop 转后台任务表,`task:update` 事件推送进度,支持取消。
7. **B-4 校验异步化 + API 鉴权**:`ctx.fs.stat` 替代 `existsSync`;API 校验请求归属(agent session 绑定)。
8. **B-5 快照保留策略**:TTL(如 7 天)+ 每会话上限;rollback/完成时清理。
9. **B-6 清理 hack 与语义**:修 `purpose` hack;`edit()` 对 applied 状态显式拒绝;fix-loop 用解析后路径匹配。

### Phase C — 体验与工程质量(P2,持续)

10. **C-1 事件驱动前端**:Host 暴露 SSE(或 DSH 客户端事件桥),`change:*`/`task:*` 推送刷新,替代轮询。
11. **C-2 共享类型**:wire 类型改为从 host 模型生成或共享包,消除手抄。
12. **C-3 样式与文案统一**:全部组件收敛到 CSS Module + 设计 token;文案抽 locale 表。
13. **C-4 工程基建**:`git init` + `.gitignore`(node_modules、.dsh 数据)+ README + API 文档 + CI(vitest + tsc)。

---

## 四、执行顺序与验收口径

| 里程碑 | 内容 | 验收 |
|--------|------|------|
| M0 | Phase 0 范围裁剪 | 无 approval/workflow 残留;typecheck + 全量测试绿 |
| M1 | Phase A 修复阻断 | `vitest run` 全绿;沙箱环境 apply/rollback/history 可用;重启后数据保留 |
| M2 | Phase B 加固 | 大文件 diff 不卡;长任务可取消有进度;API 有分页与鉴权;快照有上限 |
| M3 | Phase C 体验/工程 | 前端无轮询;类型单一来源;文档齐全;CI 绿 |

> 建议顺序:**Phase 0(裁剪)先行**——先落定"接收/拒绝/回滚"的产品边界,再做 Phase A 的持久化修复,避免在即将删除的代码上投入修复成本。
