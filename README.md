# pi-minimal-mode

> 针对 [pi](https://github.com/earendil-works/pi-coding-agent) 的锚定轮次极简模式：在**全新会话**中键入 `/minimal`，会立即触发一次**隔离的锚定轮（anchor turn）**——仅包含 `SYSTEM.md` 的系统提示、**0 个工具**、固定的锚定消息、**强制思考（可见推理）**——随后自动提升（promote）为**完整工具集**和 pi 的**完整系统提示**。你的真实消息随后直接在组装好的完整上下文中发送。

为解锁deepseek V4的完整能力，参考b站小明xiaobright的实现和up主”诗倾弦“的：“极简模式并非DeepseekV4Pro问题的根因，蓝色大肥鱼人格分裂的治疗探索”研究创造的本extension,专为pi打造
参考来自 DeepSeek Harness 的 `minimal` 预设，以及
[`dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard) 的 bootstrap→promotion 设计。
在这里感谢deepseek吧帖子：关于在PI上复现v4 pro正式版的we need思维链。为本插件提供的思路

## 为什么

据deepseek社区研究观察：当deepseek思维链中出现大量 We need, I need等词时，模型输出质量大幅度提示，根据up主”诗倾弦“的研究，当输入给deepseek v4 pro的上下文中不包含 tools字段时，Let me 出现频率最低，故以此作为本插件实现该思路，

## 工作原理

```text
新会话，键入 /minimal —— 锚定轮立即开始：

┌─ 锚定轮（由 /minimal 本身触发，仅一次请求）──────────────┐
│  system     : SYSTEM.md 的内容                              │
│               （项目 .pi/SYSTEM.md → 全局 ~/.pi/agent/SYSTEM.md）│
│               没有 SYSTEM.md 则不发送任何系统消息            │
│  messages   : [user: "This round is a test round with no task. │
│                We need to do nothing here; all tools will      │
│                open next round"]                              │
│  tools      : 无（0 个工具）                                  │
│  max_tokens : 4096（仅锚定请求）                              │
│  thinking   : 启用（推理过程会流式输出并可见）                 │
└──────────────────────────────────────────────────────────────┘
        │  助手确认（message_end）
        ▼  提升（PROMOTION）
┌─ 完整上下文（之后的每次请求，包括你的真实消息）─────────────┐
│  messages   : [锚定 user, 锚定 assistant, 你的真实 user]      │
│  tools      : 所有已注册工具（内置 + MCP + 扩展）              │
│  system     : 原样恢复 pi 的完整系统提示                       │
│               （AGENTS.md、skills、memory 等全部恢复）         │
└──────────────────────────────────────────────────────────────┘
```

- **锚定消息注入**：`/minimal` 立即调用 `pi.sendUserMessage(ANCHOR_MESSAGE)`（扩展 API——事件/命令处理器的 `ctx` **不暴露** `sendUserMessage`；使用 `ctx.sendUserMessage` 会静默无效，并使锚定状态卡住、吞掉之后的所有消息）。锚定消息是固定文本：
  `This round is a test round with no task. We need to do nothing here; all tools will open next round`。
- **锚定请求强制开启思考**，这样你可以看到模型的推理；`max_tokens` 提高到 `4096`。
- **不重写消息**：你的真实消息永远不会被转换。如果你在锚定轮期间输入消息（很少见，它只持续一个简短回复），消息会被临时挂起，并在提升后原样释放。
- **提升触发**：在锚定 `message_end` 时触发；`turn_end` / `agent_end` / `tool_call` /
  `before_agent_start` / `context` 事件作为兜底。
- **状态仅存于内存**（按 `sessionId`）。重启后，恢复旧会话遵循 pi 的默认行为——极简模式仅适用于在其为全新状态时启用的会话。

## 锚定轮 vs. 真实轮（上下文构成）

| | 锚定轮（由 `/minimal` 触发） | 真实轮（你的第一条真实消息） |
| --- | --- | --- |
| system | 仅 `SYSTEM.md`（无 AGENTS.md/skills/cwd） | pi 完整系统提示（SYSTEM.md + `<project_context>` + `<available_skills>` + cwd） |
| messages | `[锚定 user]` | `[锚定 user, 锚定 assistant, 真实 user]` |
| tools | `[]` | 空工具集 |
| max_tokens | `4096` | 你的默认值 |
| thinking | 强制 `enabled`（可见） | 你的正常设置 |

## 用法

| 命令 | 行为 |
| --- | --- |
| `/minimal` | 启用。仅在**全新会话**（无消息历史）中允许。否则报错拒绝。立即开始锚定轮。 |
| `/minimal off` | 禁用。恢复 pi 的默认系统提示；工具保持完整集。 |
| `/minimal status` | 显示当前状态（已禁用 / 锚定轮进行中 / 已提升）。 |

## 安装

1. 将此目录复制到你的 pi agent 目录，例如 `~/.pi/agent/packages/pi-minimal-mode/`
2. 将路径追加到 `~/.pi/agent/settings.json` 的 `packages` 数组**末尾**
   （`before_agent_start` 处理器链按加载顺序应用，此扩展必须最后运行，才能在锚定轮期间覆盖其他扩展的系统提示注入）：

   ```json
   { "packages": [ "...existing...", "packages/pi-minimal-mode" ] }
   ```

3. 重新加载 pi（`/reload`）或重启。

## 缓存行为

- 为保证缓存命中成本，本插件只有在新对话的第一次消息时，用户主动输入 “/minimal”触发，其他已有历史记录会话无效
- 锚定轮携带一个字节级稳定的微型系统提示且**没有工具**，因此成本很低，且绝不会干扰提供商的缓存结构。
- 提升时，系统文本发生变化，工具列表从空变为完整——一次缓存破坏，这正是 dsh-anchored-standard 设计明确接受的代价。之后一切保持稳定；
  锚定轮的消息保留在历史中，并从此仅追加。

## 环境要求

- pi（已在 0.84.x 上测试）
- 运行测试需要 Node.js ≥ 18

## 已知bug
- 由于pi的fullscreen的渲染问题，会导致锚定结束后对话框内出现：“minimal: 已启用，正在执行锚定轮（0 工具 + SYSTEM.md 极简 system，max_tokens=4096 + thinking）…”
- 此为pi渲染循环正常现象，用户无需在意，可以直接在对话框内输入或点击对话框，触发pi渲染后即会消失

## 思维链引导测试实验
- 使用deepseek v4 pro oneshot了一个黑洞，具体提示词为：
- 【角色设定】
你是一位精通 WebGL 和 Three.js 的资深图形学专家。

【任务目标】
请编写一个完整的、单文件的 HTML 代码，使用 Three.js 实现一个高质量的“黑洞”可视化效果。

【技术要求】

框架：使用 ES Modules 方式引入 Three.js (使用 importmap)。
渲染器：必须使用 WebGLRenderer 并开启 antialias。
性能：确保代码能在现代浏览器流畅运行。
【视觉特效详细需求】
请实现以下核心黑洞特征：

事件视界：
创建一个黑色的核心球体，完全吸收光线，作为黑洞本体。
在核心外围创建一层“光子球”效果，使用着色器模拟黑洞边缘的光线弯曲，边缘应有发光的边缘效应。
吸积盘：
这是视觉重点。不要使用简单的纹理，请编写 GLSL 着色器来生成动态的吸积盘。
颜色：从黑洞核心向外颜色由暗红过渡到亮橙，再到黄白，模拟高温等离子体。
形状：吸积盘应呈现明显的“多普勒增亮”效应——由于旋转，朝向观察者的一侧更亮，远离的一侧更暗。
动态：吸积盘应具有流动感，使用噪声函数让火焰纹理流动。
引力透镜：
在黑洞周围实现背景星空的扭曲效果。可以通过后期处理或者一个反向的透明球体着色器来实现背景星空的折射和扭曲，让黑洞看起来像是在吞噬背后的星空。
背景环境：
添加高质量粒子系统作为背景星空，粒子要小而密，微弱闪烁。
【交互与动画】

添加 OrbitControls，允许用户通过鼠标拖拽旋转视角查看黑洞。
黑洞整体应有缓慢的呼吸感或脉动感。
吸积盘必须有持续的旋转和湍流动画。
【输出形式】
请输出一个完整的 HTML 代码块，不需要解释代码原理，我直接保存为 .html 文件即可运行。

## 碎碎念

- 测试了几组只有This round is a test round with no task. We need to do nothing here; all tools will open next round+Pi标准上下文的会话，且assistant作为历史消息message[0]的情况，发现思维链中依然有大量let me, 得出结论，deepseek v4对预设系统提示词的过拟合不如对tool工具集的过拟合

## 许可证

MIT


