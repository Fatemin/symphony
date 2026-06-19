# 设计文档：pipeline agent 执行控制（Workflow 工具开关 + thinking effort）

> 状态：**提案 / 未实现**（本期只设计，不写代码）。
> 文中 `file:line` 为撰写时的指示位置，实现前以当前代码为准。

本文档涵盖**两个共用同一套配置机器**（config 优先级链 + `agentInput()` 解析骨架）的 pipeline agent
执行控制特性：

- **特性一 · Workflow 工具开关**（`enable_workflow_tool`，§1–§9）：布尔，默认**关**；落点在 **runner 进程 env**
  （注入 `CLAUDE_CODE_DISABLE_WORKFLOWS=1`）。
- **特性二 · thinking effort**（`thinking_effort`，§10）：枚举，默认 `none`；落点在 **prompt 尾部文本**
  （追加思考关键词）。

二者在 UI 上并列为「agent 执行控制」分组，共用同一条 mutation → API → repo 持久化链。下文 §1–§9 描述特性一，
§10 描述特性二（仅给出与特性一的差异部分，共用机制不重复）。

## 1. 背景与目标

Claude Code 内置 "Workflow" 多智能体工具允许单个 agent 自行 spawn 后台运行。这与 Symphony 的核心
不变量冲突：**orchestrator 是唯一的调度权威**（`src/server/orchestrator/`，`RuntimeState` 只由编排
层修改）。一个能自启后台 run 的 agent 等于一个隐藏的第二调度器，绕过 WIP 上限、retry/give-up 与
worktree 隔离。

当前 pipeline 子进程通过 `env: process.env` 直接继承父环境（`claudeRunner.ts:70`，已核验），未做任何
屏蔽 —— 因此 **Workflow 默认对 pipeline agent 可达**。

目标：新增一个 **默认关闭**、可按项目（及全局）覆盖的开关。关闭时在 spawn 的子进程注入
`CLAUDE_CODE_DISABLE_WORKFLOWS=1`（已验证：`--disallowedTools` 只拦审批、不移除工具，env var 才真正禁用）。

## 2. 设计概览

新增布尔配置 `enable_workflow_tool`（默认 `false`），沿用既有 `model` / `max_turns` 的优先级链解析；
在 `agentInput()` 解析出最终值，写入 `AgentRunInput`，由 runner 在 spawn 时决定是否注入
`CLAUDE_CODE_DISABLE_WORKFLOWS=1`（**关闭 = 注入**，启用 = 不注入）。

```
[UI 开关]                          src/web/pages/ProjectAgent.tsx
   │ config.agent.enable_workflow_tool
   ▼
[PATCH /api/projects/:id]          http/routes/projects.ts:96-101
   │ → serializeProjectConfig       repo/projects.ts:90-109
   ▼
[settings 表 / project.config]     core/config.ts · core/projectConfig.ts
   │ getConfig() / mergeProjectConfigs()
   ▼
[agentInput()]                     src/server/phases/types.ts:69-99
   │ WORKFLOW.md ?? project ?? engine ?? false
   ▼
[AgentRunInput.disableWorkflows]   src/server/agent/types.ts:9-27
   │ = !enable_workflow_tool
   ▼
[claudeRunner spawn env]           claudeRunner.ts:67-72
   │ disableWorkflows ? {...env, CLAUDE_CODE_DISABLE_WORKFLOWS:'1'} : env
   ▼
[claude 子进程]  → Workflow 工具不可达
```

## 3. 配置项定义

| 项 | 值 |
|---|---|
| 名称 | `enable_workflow_tool`（布尔；语义正向，opt-in 启用） |
| 默认值 | `false`（位于 `DEFAULT_SETTINGS`，`config.ts:51-71`） |
| 类型 | boolean，存入 `settings` 表为 JSON 串 `"false"`（`repo/settings.ts` 写入 `JSON.stringify`，读取 `getAllSettings` `JSON.parse`） |
| 优先级 | `WORKFLOW.md` → 项目 `config.agent` → 引擎默认 → `false`，镜像 `agentInput()` 中 `model`/`max_turns` 的链（`phases/types.ts:84-94`） |

**⚠️ 开放问题 / Gap（必须显式处理，已核验）**：`settings` 表当前**没有通用布尔解析路径**。
`resolveConfig`（`config.ts:89-105`）只有两条路：`NUMERIC_KEYS`（纯数字，`:73-83`）和字符串兜底
（`:100-101`），布尔是 `enabled` 的**硬编码特例**（`:98-99`）。新布尔不能加进 `NUMERIC_KEYS`
（会被 `Number(false)=0` 误转），也不能走字符串分支。**必须为 `enable_workflow_tool` 新增与
`enabled` 平行的布尔特例**，例如：

```ts
} else if (key === 'enabled' || key === 'enable_workflow_tool') {
  (cfg[key] as boolean) = Boolean(value);
}
```

若以后布尔配置增多，应引入 `BOOLEAN_KEYS` 数组，但本次按既有 `enabled` 风格最小改动即可。

## 4. 后端改动点

引擎默认（全局）：
- [ ] `config.ts:14-49` — `EngineConfig` 接口加 `enable_workflow_tool: boolean`（紧随 `enabled`）。
- [ ] `config.ts:51-71` — `DEFAULT_SETTINGS` 加 `enable_workflow_tool: false`（保不变量）；经 `migrate.ts seedSettings` 的 `INSERT OR IGNORE` 自动入库。
- [ ] `config.ts:98-99` — `resolveConfig` 加布尔特例（见 §3，**这是关键且当前缺失的路径**）。

项目级覆盖：
- [ ] `projectConfig.ts:41-45` — `ProjectAgentConfig` 加 `enable_workflow_tool?: boolean`（紧随 `max_turns_by_phase`）。
- [ ] `projectConfig.ts:138-149` — `mergeAgent` 加：`if (typeof obj.enable_workflow_tool === 'boolean') out.agent.enable_workflow_tool = obj.enable_workflow_tool;`（与 `permission_mode` 同风格的逐字段合并，保证 WORKFLOW.md 层不会清掉 DB 层的其它字段）。
- [ ] （可选）`core/workflow.ts` `WorkflowPolicy` 加同名字段，使 WORKFLOW.md 可设；若本期不做，明确标注 WORKFLOW.md 暂不支持。

解析与注入：
- [ ] `phases/types.ts:69-99` `agentInput()` — 解析最终值并落到 `AgentRunInput`：
  ```ts
  const enableWf =
    ctx.workflow?.enable_workflow_tool ??
    ctx.projectConfig.agent.enable_workflow_tool ??
    ctx.config.enable_workflow_tool;          // 默认 false
  // ...
  disableWorkflows: !enableWf,
  ```
- [ ] `agent/types.ts:9-27` — `AgentRunInput` 加 `disableWorkflows: boolean`（必填，由 `agentInput()` 计算）。
- [ ] `claudeRunner.ts:67-72` — spawn 的 `env: process.env`（已核验在 `:70`）改为：
  ```ts
  env: input.disableWorkflows
    ? { ...process.env, CLAUDE_CODE_DISABLE_WORKFLOWS: '1' }
    : process.env,
  ```
- [ ] `codexRunner.ts`（同为 `env: process.env`）— 同样改造以保持一致。**开放问题**：Codex CLI 是否识别 `CLAUDE_CODE_DISABLE_WORKFLOWS` 未经验证；若不识别，注入仍无害（保持两 runner 对称），并在注释中说明该 env 仅对 claude 生效。

## 5. 前端改动点

- 共享类型：`src/web/api.ts` 的 `ProjectAgentConfig` 加 `enable_workflow_tool?: boolean`（与服务端 `projectConfig.ts` 接口对齐）。
- 控件位置：`src/web/pages/ProjectAgent.tsx` 的 Agent 面板，在 max turns 字段块之后插入一个 checkbox/toggle，标签如「允许 Workflow 多智能体工具（高级）」。
- 表单透传：`AgentForm.config` 已含嵌套 `config.agent`，normalize/sanitize 自动读写 `config.agent.enable_workflow_tool`，无需额外状态。
- mutation → API → repo 链（与现有 `permission_mode` 完全一致）：`api.projects.update()` 发 `Partial<Project>` patch → `PATCH /api/projects/:id`（`routes/projects.ts:96-101`）→ `serializeProjectConfig`（`repo/projects.ts:90-109`）持久化进 config blob。
- 全局默认（可选）：`src/web/pages/Settings.tsx` 加一个引擎级 toggle，经 `PATCH /settings`（`routes/ops.ts`）→ `settings` 表。**这里依赖 §3 的布尔解析路径必须先就绪**，否则全局值读出会被字符串分支误处理。

## 6. 默认值与不变量

- 默认 **OFF**（`enable_workflow_tool: false` ⇒ `disableWorkflows: true` ⇒ 注入 env var）。所有未设层级回落到 `false`，确保即使 UI/迁移遗漏也是安全侧。
- 这样 pipeline agent **无法**自行 spawn 后台 run，`orchestrator` 仍是唯一调度权威，WIP 上限 / retry / give-up / worktree 隔离全部有效。
- **启用的含义**：项目方显式接受嵌套编排 —— agent 可在自己的 phase 内部发起 Symphony 不可见、不计入 `RuntimeState`、不受 WIP 约束的子 run。属于"自担风险"的高级选项，UI 文案应点明。

## 7. 测试要点（离线）

- **角色子串不受影响**：env var 注入不改 prompt，也不改 argv 中的 role 标题；`fakeRunner.ts` 靠 role 子串识别 phase，照常工作。不要把开关塞进 prompt/system prompt。
- **断言 env**：`fakeRunner` 只收 `AgentRunInput`，可直接断言 `input.disableWorkflows`：默认项目 → `true`；项目设 `enable_workflow_tool: true` → `false`。覆盖三层优先级（引擎默认 / 项目覆盖 / 若实现 WORKFLOW.md 层）。
- **真实 env 注入**单独用一个 spawn 包装的单元测试覆盖 `claudeRunner` 的 env 分支（mock `spawn`，断言 `CLAUDE_CODE_DISABLE_WORKFLOWS` 存在/缺失），不接真实 CLI。
- 新增的 `AgentRunInput.disableWorkflows` 为必填，需在所有构造 `AgentRunInput` 的测试桩中补该字段，否则类型检查（`npm run lint`）失败。
- 保持 `npm test` 全程离线，不消耗 token。

## 8. 手动验证

确认 env var 真正移除工具（关闭态 vs 启用态）：

```bash
# 启用态（不注入）：Workflow 工具应可见
claude -p "List your available tools, one per line." --output-format stream-json --verbose

# 关闭态（注入）：输出中不应出现 Workflow 工具
CLAUDE_CODE_DISABLE_WORKFLOWS=1 claude -p "List your available tools, one per line." --output-format stream-json --verbose
```

对比两次输出确认仅在第二条中 Workflow 工具消失，证明 env 机制有效（且优于 `--disallowedTools`）。

## 9. 范围外 / 未来扩展

- **按 phase 粒度**：目前是 agent 会话级（per phase 都注入同一值）；未来可像 `max_turns_by_phase` 那样支持 `enable_workflow_tool_by_phase`。
- **WORKFLOW.md 层**：本期可仅做 引擎 + 项目两层；`WorkflowPolicy` 支持留待后续（已在 §4 标为可选）。
- **受控/可观测暴露**：理想终态不是"全开/全关"，而是让 orchestrator 接管/登记 agent 发起的子 run（纳入 `RuntimeState`、计入 WIP、可在 UI 观测），把隐藏调度器变成受控嵌套编排 —— 那是比布尔开关大得多的独立设计。

---

# 特性二：thinking effort（prompt-append）

> 与特性一（§1–§9）**共用同一套** config 优先级链 + `agentInput()` 解析骨架；差别只在落点：
> 特性一改 **runner 进程 env**，特性二改 **prompt 尾部文本**。本特性**不碰 runner**（不改 `agent/types.ts` /
> `claudeRunner.ts`），这点与特性一不同。

## 10. 配置项定义

新增枚举 `thinking_effort`，与 `enable_workflow_tool` 并列，复用同一优先级链。

- 类型：`type ThinkingEffort = 'none' | 'think' | 'think-hard' | 'ultrathink'`
- 默认：`'none'`（不追加任何指令，零行为变化 —— 与「安全默认」一致）
- 可选 per-phase 覆盖：`thinking_effort_by_phase?: Partial<Record<RunPhase, ThinkingEffort>>`，镜像 `max_turns_by_phase`。MVP 可只做扁平字段。

**枚举 → 追加正文**（追加块形如 `## Thinking effort\n<正文>`，正文为 Claude 原生关键词字面量，预算升级靠字面匹配）：

| `thinking_effort` | 追加正文 | 触发 |
|---|---|---|
| `none` | （不追加） | 默认 |
| `think` | `think` | 基础扩展思考 |
| `think-hard` | `think hard` | 提升思考预算 |
| `ultrathink` | `ultrathink` | 最高思考预算 |

**优先级链**（与 `max_turns` 完全一致，`phases/types.ts:84-94`）：
```
ctx.workflow?.thinking_effort_by_phase?.[ctx.phase]
  ?? ctx.workflow?.thinking_effort
  ?? ctx.projectConfig.agent.thinking_effort_by_phase?.[ctx.phase]
  ?? ctx.projectConfig.agent.thinking_effort
  ?? ctx.config.thinking_effort          // 默认 'none'
```

**config.ts 解析路径（已核验）**：`resolveConfig`（`config.ts:89-105`）的字符串回退分支（`:100-101`）会接受
**任意非空字符串、不校验取值**，会让非法值污染配置。因此须在 `enabled` 布尔特例之后加一个白名单分支：

```ts
} else if (key === 'thinking_effort') {
  const v = String(value).toLowerCase();
  if (['none', 'think', 'think-hard', 'ultrathink'].includes(v))
    (cfg.thinking_effort as ThinkingEffort) = v as ThinkingEffort;
}
```

> 与特性一的「布尔缺口」不同：`enable_workflow_tool` 是布尔、必须新建特例；`thinking_effort` 是字符串枚举，
> 本可走现有字符串回退，但回退不校验取值，故仍建议加白名单分支。

## 11. 注入点与机制（关键，已核验结构）

实测整段 prompt 的真实结构 —— claudeRunner 把它作为**单条 user message** 喂给子进程（`claudeRunner.ts:82-83`）：

```
[issueBrief(ctx) 输出]              prompt.ts:56-148
---
You are the **tech lead** ...      role + task 指令（prompt.ts:161 起；其余 phase builder 同构）
[可选] ## Repository policy ...     withPolicy 在整段末尾追加（prompt.ts:49-51）
```

`fakeRunner.ts:40-44` 用 `includes()` 检测的 role 子串（`**implementing engineer**` / `independent **QA engineer**` /
`**delivery lead**` / `**release engineer**`，否则 plan）**全部位于 `issueBrief()` 之后**。只要只做「追加」、且不动
issueBrief 之后内容的相对顺序，phase 检测就不受影响（`includes()` 只看存在性，不看偏移）。

两个可行落点：

- **方案 1（推荐做 MVP）— issueBrief 尾部追加，完全复刻 SYM-35。** 在 `issueBrief()` 末尾（retry-note 块
  `prompt.ts:137-147` 之后、`return` `prompt.ts:148` 之前）`push` 一个 `## Thinking effort` 段。
  优点：**单点改动**（ctx 已在手）、零 call-site 改动、与 CLAUDE.md 钦定的 SYM-35 安全追加范式一致、role 子串绝不位移。
- **方案 2（altitude 更干净）— 整段 prompt 真正末尾追加。** 加一个 `withPolicy` 的姊妹函数
  `withThinkingEffort(prompt, level)`，在 role + task（+ Repository policy）之后再追加，使思考指令成为全 prompt 收尾。
  代价：需改 ~6 个 `buildXxxPrompt` call-site（或扩 `withPolicy` 签名）。语义上更对 —— thinking 是**执行指令**而非
  issue 上下文，本不该混进 `issueBrief()`。

**建议**：MVP 走方案 1（最小面 + 循 SYM-35 先例）；若后续在意 altitude，平移到方案 2。两者对触发同样有效 ——
扩展思考关键词靠字面匹配、位置不敏感，且都落在 user turn 内。

落点 before/after（方案 1，`ultrathink`）：

```
> This is retry attempt 2. ...          ← issueBrief 既有尾部（prompt.ts:137-147）
                                          ← 新增（prompt.ts:147 之后）
## Thinking effort
ultrathink
                                          ← issueBrief return（prompt.ts:148）
---
You are the **tech lead** ...           ← role 子串，位置不变，fakeRunner 仍可检测
```

**为何走 user-turn 而非 `--append-system-prompt`**：整段 prompt 即 user message，关键词在 user turn 触发最确定；
`--append-system-prompt`（`claudeRunner.ts:55`，现仅 Ask 路由用）的关键词触发行为是开放问题，留作一行可切换的备选。

> **作用域天然限于 pipeline**：`issueBrief()` 虽也被 Ask 复用，但只有 pipeline 的 `agentInput()` 会往 ctx 里塞
> `thinkingEffort`，Ask 不传 → Ask 不受影响，无需额外隔离。

## 12. 后端改动点

- [ ] `config.ts:8` — 新增 `type ThinkingEffort = 'none'|'think'|'think-hard'|'ultrathink'`。
- [ ] `config.ts:14-49` `EngineConfig` — 加 `thinking_effort: ThinkingEffort`（紧随 `max_turns`）。
- [ ] `config.ts:51-71` `DEFAULT_SETTINGS` — 加 `thinking_effort: 'none'`。
- [ ] `config.ts:89-105` `resolveConfig` — 在 `enabled` 特例之后加白名单分支（见 §10）。
- [ ] `projectConfig.ts:41-45` `ProjectAgentConfig` — 加 `thinking_effort?: ThinkingEffort`（如做 by-phase，再加 `thinking_effort_by_phase?`）。
- [ ] `projectConfig.ts:138-149` `mergeAgent` — 加 `if (isThinkingEffort(obj.thinking_effort)) out.agent.thinking_effort = obj.thinking_effort;`。
- [ ] `projectConfig.ts:273` 附近（`isPermissionMode` 旁）— 加校验器 `isThinkingEffort()`。
- [ ] `phases/types.ts:84-94` `agentInput()` — 按 §10 优先级链解析 `thinkingEffort`，作为**数据**透传给 prompt 构建（**不进** `systemPrompt`/`--append-system-prompt`）。
- [ ] `core/prompt.ts` — `PromptContext` 加 `thinkingEffort?: ThinkingEffort`；按方案 1 在 `issueBrief()` 尾部 `push`，或按方案 2 加 `withThinkingEffort`。各 `buildXxxPrompt` 调用 `issueBrief(ctx)` 时 ctx 已携带该值，方案 1 无需逐个改签名。
- [ ] （可选）`core/workflow.ts` `WorkflowPolicy` — 加 `thinking_effort?`（第三层，optional，与特性一一致）。
- [ ] **不动** `agent/types.ts` 的 `AgentRunInput`、不动 `claudeRunner.ts:42-55` —— 本特性走 prompt，不碰 runner。

## 13. 前端改动点

- `src/web/components/ProjectAgent.tsx` — 在 Workflow 工具开关旁加一个 4 档下拉/分段控件（none / think / think-hard / ultrathink），与开关同属「agent 执行控制」分组，视觉并列呼应「姊妹特性」。
- `src/shared/types.ts` — 项目 agent 配置类型加 `thinking_effort?: ThinkingEffort`（与 `enable_workflow_tool` 同处）。
- mutation → API → repo 链：复用特性一已建立的同一条更新链路，`thinking_effort` 作为同一 payload 的新字段，无需新端点；全局默认仍走 `settings` 表。

## 14. 测试要点（离线）

- **role 子串检测不受影响**：追加块落在 `issueBrief()` 内、role 标题之前，`fakeRunner.ts:40-44` 的 `phaseOf()` 仍正确分相位。新增断言：开 `ultrathink` 后五个 phase 仍被正确识别。
- **追加存在/缺失断言**：捕获传给 runner 的 `prompt` —— `none` → **不含** `## Thinking effort`；`think-hard` → **含** `## Thinking effort\nthink hard`。
- **优先级 / by-phase 断言**：project 覆盖盖过 engine 默认，再（若实现）用 by-phase 盖过扁平值，复用 `max_turns` 现有测试范式。
- `fakeRunner` 不模拟「思考深度」，仅验字段被正确装配进 prompt，保持确定性、零 token。

## 15. 与 `--effort` 的关系 / 范围外

- **原生 `--effort` 是 system 级替代杠杆**：取值 `low / medium / high / xhigh / max`（**已实测**：`max` 是上限档，**不存在 `ultracode` 档**）。可记为文档化备选；本特性选 prompt-append 是为了**零 runner 改动 + user-turn 触发确定性 + 复用既有提示词装配**。若未来要 system 级控制，可平移到 `claudeRunner` args。
- **范围外 / 未来扩展**：完整 per-phase（`thinking_effort_by_phase`，镜像 `max_turns_by_phase`）；WORKFLOW.md 第三层；以及「按 agent 后端（Claude / Codex）选不同关键词字面量」。

## 16. 开放问题

1. **关键词触发位置（user vs system prompt）**：关键词放进 `--append-system-prompt` 是否稳定触发是真实开放问题，本设计据此选 user-turn。建议实现首版做一次**真实 CLI** 验证（离线 `npm test` / fake 验不了触发语义）。
2. **关键词字面量的跨 agent 差异**：`think` / `think hard` / `ultrathink` 是否对 Codex 后端同义需在实现期校准；必要时按 `agent` 分支选不同字面量。
3. **WORKFLOW.md 是否纳入第三层**：与特性一一致，建议 optional，MVP 只做 engine 默认 + project 两层。
