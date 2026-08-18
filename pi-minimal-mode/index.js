/**
 * pi 扩展：Minimal 两阶段模式（独立锚定轮 → 完整 pi 上下文）
 *
 * 参考 DeepSeek Harness `minimal` 预设与 dsh-anchored-standard 的
 * bootstrap→promotion 两阶段设计，「独立锚定轮」：
 *
 * 阶段一（锚定轮，仅全新会话 + 输入 /minimal 后立即触发一次）：
 *   - system prompt = SYSTEM.md 内容（项目 .pi/SYSTEM.md → 全局 agentDir/SYSTEM.md），
 *   - 自动注入一条固定锚定用户消息（原文见 ANCHOR_MESSAGE），模型先思考再输出一句确认
 *   - 工具 0 个
 *
 * 提升（promotion）：
 *   - 触发：锚定输出结束（message_end / agent_end / turn_end 任一）即提升；
 *     tool_call / before_agent_start / context 事件兜底（锚定未完成但已被推进 → 提升）
 *   - 动作：setActiveTools(全部工具名) + 置 promoted + anchorActive=false
 *   - 效果：下一轮起 tools 全量；before_agent_start 不再覆盖 system
 *     → 恢复 pi 完整系统提示词（含 AGENTS.md、skills、Memory 等）
 *
 * 锚定轮期间用户手快输入的真实消息：input 事件暂存（pendingUserInput，多条 \\n\\n 合并），
 * 锚定轮结束（finishAnchor：message_end / agent_end / turn_end）后自动以完整 pi 上下文释放；
 * 若锚定请求从未真正启动（sendUserMessage 失败且 agent 空闲），input 事件会自愈：
 *
 * 命令：
 *   /minimal          启用（仅全新会话可用，已有历史则报错），启用后立即触发锚定轮
 *   /minimal off      关闭（恢复默认 system，工具保持全量）
 *   /minimal status   查看当前会话状态，仅本次聊天
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_AGENT_DIR = join(homedir(), ".pi", "agent");

/** 锚定轮自动注入的用户消息（参考deepseek harness 极简模式系统提示词） */
const ANCHOR_MESSAGE =
  "This round is a test round with no task. We need to do nothing here; all tools will open next round";
const ANCHOR_MAX_TOKENS = 4096;

export default function (pi) {
  /**
   * sessionId -> {
   *   enabled,            // /minimal 已启用
   *   anchorActive,       // 锚定轮进行中（未 promote）
   *   anchorSubmitted,    // 锚定消息已注入（防重复）
   *   promoted,           // 已提升为完整上下文
   *   pendingUserInput,   // 锚定轮期间用户输入的真实消息（多条 \n\n 合并）
   *   pendingReleased,    // pendingUserInput 已释放（防重复）
   *   firstTurnSeen,      // 首轮 before_agent_start 是否已见过（兜底用）
   * }
   */
  const states = new Map();

  const getAgentDir = () =>
    process.env.PI_CODING_AGENT_DIR ||
    process.env.PI_AGENT_DIR ||
    DEFAULT_AGENT_DIR;

  const stateFor = (sessionId) => {
    if (!sessionId) return null;
    let s = states.get(sessionId);
    if (!s) {
      s = {
        enabled: false,
        anchorActive: false,
        anchorSubmitted: false,
        promoted: false,
        pendingUserInput: null,
        pendingReleased: false,
        firstTurnSeen: false,
      };
      states.set(sessionId, s);
    }
    return s;
  };

  /**
   * 读取首轮 SYSTEM.md：
   *   项目 <cwd>/.pi/SYSTEM.md（项目受信任时）→ 全局 <agentDir>/SYSTEM.md
   */
  const readSystemMd = (cwd, trusted) => {
    if (trusted) {
      const project = join(cwd, ".pi", "SYSTEM.md");
      if (existsSync(project)) {
        try {
          return readFileSync(project, "utf-8");
        } catch {
          return "";
        }
      }
    }
    const global = join(getAgentDir(), "SYSTEM.md");
    if (existsSync(global)) {
      try {
        return readFileSync(global, "utf-8");
      } catch {
        return "";
      }
    }
    return "";
  };

  /** 全部已注册工具名（内置 + MCP direct tools + 其他扩展工具） */
  const allToolNames = () => {
    try {
      return pi.getAllTools().map((t) => t.name);
    } catch {
      return [];
    }
  };

  /** 提升：暴露全部工具 + 置 promoted + anchorActive=false。幂等。 */
  const promote = (sessionId) => {
    const s = stateFor(sessionId);
    if (!s || !s.enabled || s.promoted) return;
    const names = allToolNames();
    if (names.length === 0) return; // 防御：拿不到工具列表时保持现状，后续事件重试
    try {
      pi.setActiveTools(names);
      s.promoted = true;
      s.anchorActive = false;
    } catch (err) {
      // 提升失败不置标志，后续事件会重试
      console.error(
        `[minimal] promote failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * 释放锚定轮期间暂存的真实消息（以完整 pi 上下文直接发送）。
   * 方法内部是 fire-and-forget
   * （runtime.sendUserMessage 自带 .catch 错误兜底），不阻塞事件链。
   */
  const releasePending = (sessionId) => {
    const s = stateFor(sessionId);
    if (
      !s?.enabled ||
      !s.anchorSubmitted ||
      s.pendingReleased ||
      s.pendingUserInput == null
    ) {
      return;
    }
    s.pendingReleased = true;
    const text = s.pendingUserInput;
    s.pendingUserInput = null;
    try {
      pi.sendUserMessage(text);
    } catch (err) {
      console.error(
        `[minimal] release pending failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * 收尾锚定轮：提升 + 释放暂存消息（供 message_end / agent_end / turn_end 复用）。
   * promote/release 均幂等；正常流程 message_end 即完成，后两者仅兜底异常路径
   * （message_end 未触发/请求失败/流异常时，agent_end 与 turn_end 保证状态恢复）。
   */
  const finishAnchor = (sessionId) => {
    promote(sessionId);
    releasePending(sessionId);
  };

  /**
   * 校验会话是否已有历史消息。
   * 会话 JSONL 中只要存在 type === "message" 条目即视为有历史；
   */
  const sessionHasHistory = (sessionFile) => {
    if (!sessionFile || !existsSync(sessionFile)) return false;
    try {
      const text = readFileSync(sessionFile, "utf-8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const entry = JSON.parse(trimmed);
        if (entry?.type === "message") return true;
      }
      return false;
    } catch {
      return true;
    }
  };

  /** 命令输出：有 UI 时弹通知，同时写 stdout（headless 可见） */
  const say = (ctx, message, kind = "info") => {
    console.log(message);
    try {
      ctx.ui?.notify?.(message, kind);
    } catch {
      // UI 不可用时忽略
    }
  };

  // ------------------------------------------------------------------ 事件

  // 会话启动：确保当前会话有状态记录（惰性创建，防止跨会话串状态）
  pi.on("session_start", async (_event, ctx) => {
    const sid = ctx.sessionManager?.getSessionId();
    if (sid) stateFor(sid);
  });

  // 锚定轮阶段：覆盖 system 为 SYSTEM.md（无则空）；promotion 后不干预
  pi.on("before_agent_start", async (_event, ctx) => {
    const sid = ctx.sessionManager?.getSessionId();
    const s = stateFor(sid);
    if (!s?.enabled || s.promoted) return undefined;
    // 兜底：已见过首轮 before_agent_start 但仍未提升（异常路径）→ 立即提升
    if (s.firstTurnSeen) {
      promote(sid);
      return undefined;
    }
    s.firstTurnSeen = true;
    return {
      systemPrompt: readSystemMd(ctx.cwd, ctx.isProjectTrusted?.() ?? false),
    };
  });

  /**
   * 用户输入拦截（仅锚定轮未完成时生效）：
   *   - 锚定消息本身：放行（sendUserMessage → prompt → input 再次触发，防递归死锁）
   *   - 锚定轮期间的真实用户消息：暂存合并，不进历史；锚定轮结束后由 finishAnchor 释放
   *   - 自愈：锚定消息已声明提交但 agent 处于空闲（说明 sendUserMessage 失败、请求从未
   *     真正启动）→ 立即提升并放行，避免用户被永久吞消息
   */
  pi.on("input", async (event, ctx) => {
    const sid = ctx.sessionManager?.getSessionId();
    const s = stateFor(sid);
    if (!s?.enabled || !s.anchorActive || s.promoted) return undefined;
    if (event.text === ANCHOR_MESSAGE) return undefined;
    if (s.anchorSubmitted && (ctx.isIdle?.() ?? false)) {
      // 锚定请求从未真正启动 → 立即提升，本次输入放行
      promote(sid);
      return undefined;
    }
    s.pendingUserInput =
      s.pendingUserInput == null
        ? event.text
        : s.pendingUserInput + "\n\n" + event.text;
    return { action: "handled" };
  });

  /**
   * 锚定请求专用参数（仅锚定轮生效，原地改 provider payload）：
   *   - max_tokens = 4096（思考模型下给 thinking 留空间）
   *   - 强制开启思考：thinking disabled → enabled（deepseek / anthropic 格式）；
   *     无 thinking 字段且无 openai 风格 reasoning_effort 时补 deepseek 格式字段。
   */
  pi.on("before_provider_request", async (event, ctx) => {
    const sid = ctx.sessionManager?.getSessionId();
    const s = stateFor(sid);
    if (!s?.enabled || !s.anchorActive || s.promoted) return undefined;
    const payload = event.payload;
    if (!payload || typeof payload !== "object") return undefined;
    payload.max_tokens = ANCHOR_MAX_TOKENS;
    const th = payload.thinking;
    if (th && typeof th === "object" && th.type === "disabled") {
      th.type = "enabled";
      // anthropic 格式需要 budget_tokens；deepseek 格式会忽略该字段
      th.budget_tokens = Math.min(
        th.budget_tokens ?? 2048,
        Math.max(768, payload.max_tokens - 1024),
      );
    } else if (
      !th &&
      !("thinking" in payload) &&
      !("reasoning_effort" in payload) &&
      Array.isArray(payload.messages)
    ) {
      // 无 thinking 字段且无 openai 风格 effort → 尝试 deepseek/zai 格式
      payload.thinking = { type: "enabled" };
    }
    return undefined;
  });

  // 工具调用 → 提升（锚定轮 0 工具通常不触发；若配置 bootstrap 工具则提前提升）
  pi.on("tool_call", async (_event, ctx) => {
    const sid = ctx.sessionManager?.getSessionId();
    promote(sid);
  });

  // 锚定输出结束 / 轮结束 / 会话循环结束 → 提升 + 释放暂存消息（各自幂等）
  pi.on("message_end", async (_event, ctx) => {
    const sid = ctx.sessionManager?.getSessionId();
    finishAnchor(sid);
  });
  pi.on("turn_end", async (_event, ctx) => {
    const sid = ctx.sessionManager?.getSessionId();
    finishAnchor(sid);
  });
  pi.on("agent_end", async (_event, ctx) => {
    const sid = ctx.sessionManager?.getSessionId();
    finishAnchor(sid);
  });

  // 兜底：请求发送前若发现会话已有 assistant 消息但仍未提升 → 提升
  pi.on("context", async (event, ctx) => {
    const sid = ctx.sessionManager?.getSessionId();
    const s = stateFor(sid);
    if (
      s?.enabled &&
      !s.promoted &&
      event.messages.some((m) => m.role === "assistant")
    ) {
      promote(sid);
    }
    return event.messages;
  });

  // ------------------------------------------------------------------ 命令

  pi.registerCommand("minimal", {
    handler: async (args, ctx) => {
      const sid = ctx.sessionManager?.getSessionId();
      const arg = (args ?? "").trim();
      const s = stateFor(sid);

      // /minimal off：关闭并恢复默认（清理全部锚定相关状态）
      if (arg === "off") {
        if (!s?.enabled) {
          say(ctx, "minimal: 当前会话未启用 minimal 模式");
          return;
        }
        const names = allToolNames();
        if (names.length > 0) {
          try {
            pi.setActiveTools(names);
          } catch (err) {
            console.error(
              `[minimal] restore tools failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        s.enabled = false;
        s.anchorActive = false;
        s.anchorSubmitted = false;
        s.promoted = false;
        s.pendingUserInput = null;
        s.pendingReleased = false;
        s.firstTurnSeen = false;
        say(ctx, "minimal: 已关闭，恢复 pi 默认系统提示词（工具保持全量）");
        return;
      }

      // /minimal status：查看状态
      if (arg === "status") {
        let label;
        if (!s?.enabled) {
          label = "未启用";
        } else if (s.promoted) {
          label = "已启用（已提升为完整 pi 上下文：全量工具 + 完整 system）";
        } else {
          label =
            "已启用（锚定轮执行中：0 工具 + SYSTEM.md 极简 system，max_tokens=4096 + thinking）";
        }
        say(ctx, `minimal: ${label}`);
        return;
      }

      // 未知参数
      if (arg) {
        say(
          ctx,
          `minimal: 未知参数 "${arg}"，用法：/minimal | /minimal off | /minimal status`,
        );
        return;
      }

      // /minimal：启用（仅全新会话）
      if (s?.enabled) {
        say(ctx, "minimal: 当前会话已启用");
        return;
      }
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      if (sessionHasHistory(sessionFile)) {
        say(
          ctx,
          "minimal: 当前会话无法使用 minimal 模式（已有对话历史），请开新会话后重试",
          "error",
        );
        return;
      }
      try {
        pi.setActiveTools([]);
      } catch (err) {
        console.error(
          `[minimal] setActiveTools([]) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        say(ctx, "minimal: 启用失败，无法清空工具集", "error");
        return;
      }
      s.enabled = true;
      s.anchorActive = true;
      s.anchorSubmitted = true;
      s.promoted = false;
      s.pendingUserInput = null;
      s.pendingReleased = false;
      s.firstTurnSeen = false;
      say(
        ctx,
        "minimal已启用，已执行锚定轮（0 工具 + SYSTEM.md）",
      );
      // 立即触发锚定请求：必须用扩展 API pi.sendUserMessage（ctx 无此方法）；
      // 不 await 避免命令阻塞；runtime.sendUserMessage 内部已带 .catch 错误兜底
      try {
        pi.sendUserMessage(ANCHOR_MESSAGE);
      } catch (err) {
        console.error(
          `[minimal] inject anchor failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });
}
