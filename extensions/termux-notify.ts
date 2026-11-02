/**
 * Termux Notification Hook Extension
 *
 * 将 Pi 生命周期 hook 与 Termux API (termux-notification) 结合：
 *   - `agent_settled`: agent 运行完全结束（等待输入）时通知。
 *   - `ui_prompt_start`: Pi 弹出交互对话框（审批/确认/输入）时通知。
 *   - `tool_execution_end`: 工具运行超过阈值后完成时通知。
 *   - `tool_call`: 需要审批的危险命令，改走「通知按钮」直接审批（同意/拒绝），
 *     无需切回终端。通过状态文件回传决策。
 *
 * 配置（环境变量）：
 *   - PI_TERMUX_NOTIFY=off            完全禁用通知（默认开启）。
 *   - PI_TERMUX_NOTIFY_THRESHOLD_MS=60000  长任务阈值（毫秒，默认 60000）。
 *   - PI_TERMUX_NOTIFY_PRIORITY=high  通知优先级。
 *   - PI_TERMUX_NOTIFY_ID=pi          通知 id。
 *   - PI_APPROVE=on                   启用通知审批（默认开启；off 关闭）。
 *   - PI_APPROVE_PATTERNS=...         审批匹配正则（| 分隔），默认危险命令集合。
 *   - PI_APPROVE_TIMEOUT_MS=120000    审批超时（毫秒），超时拒绝（fail-closed）。
 *
 * 加载：
 *   - 放到 ~/.pi/agent/extensions/termux-notify.ts 自动发现；或
 *   - pi --extension ./termux-notify.ts 手动加载。
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
	AgentActivityOutcome,
	ExtensionAPI,
	ToolCallEvent,
	ToolExecutionEndEvent,
	UIPromptStartEvent,
} from "@earendil-works/pi-coding-agent";

// ---------- 配置 ----------
const DISABLED = ["0", "off", "false"].includes((process.env.PI_TERMUX_NOTIFY ?? "").toLowerCase());
const THRESHOLD_MS = Number(process.env.PI_TERMUX_NOTIFY_THRESHOLD_MS ?? 60000);
const NOTIFY_ID = process.env.PI_TERMUX_NOTIFY_ID ?? "pi";
const PRIORITY = process.env.PI_TERMUX_NOTIFY_PRIORITY ?? "high";

const APPROVE_ENABLED = !["0", "off", "false"].includes((process.env.PI_APPROVE ?? "on").toLowerCase());
const APPROVE_TIMEOUT_MS = Number(process.env.PI_APPROVE_TIMEOUT_MS ?? 120000);
const APPROVE_FILE = join(process.env.HOME ?? "", ".pi", "agent", "approval.json");
// 多个模式用分号分隔（模式内部可含 |，如 (-rf?|--recursive)）。
const APPROVE_PATTERNS = (
	process.env.PI_APPROVE_PATTERNS ??
	"\\bsudo\\b;\\brm\\s+(-rf?|--recursive)\\b;\\b(chmod|chown)\\b.*777"
)
	.split(";")
	.filter(Boolean)
	.map((p) => new RegExp(p, "i"));

// ---------- 通知 ----------
/**
 * 通过 Termux API 发送系统通知（后台执行，不阻塞）。
 * 只有没有按钮时，才给通知主体加 --action（点击主体时前置 Termux 窗口）；
 * 有按钮时靠按钮操作，不给主体加 action，避免冲突。
 */
function notify(title: string, content: string, buttons: string[] = [], alert = false): void {
	if (DISABLED) return;
	const args = ["-t", title, "-c", content, "--priority", PRIORITY, "-i", NOTIFY_ID];
	// 审批等需要用户响应的关键通知：带提示音和震动，避免错过。
	if (alert) args.push("--sound", "--vibrate", "500,1000,200");
	if (buttons.length > 0) {
		args.push(...buttons);
	} else {
		// 无按钮：点击通知主体时收起状态栏、前置 Termux，并移除通知。
		args.push("--action", `${collapseShade()}; am start -n com.termux/.app.TermuxActivity >/dev/null 2>&1; ${dismissCmd()}`);
	}
	execFile("termux-notification", args, { timeout: 5000 }, (err) => {
		if (err) console.error(`[termux-notify] 通知失败: ${err.message}`);
	});
}

/** 移除通知（审批完成后清理）。 */
function removeNotification(): void {
	if (DISABLED) return;
	execFile("termux-notification-remove", [NOTIFY_ID], { timeout: 5000 }, () => {});
}

/** 移除通知的命令片段（点击后清理，避免残留）。 */
function dismissCmd(): string {
	return `termux-notification-remove ${NOTIFY_ID} >/dev/null 2>&1`;
}

/** 收起状态栏（通知 shade）。`cmd statusbar collapse` 需 EXPAND_STATUS_BAR 权限，Termux 无；用系统广播最可靠。 */
function collapseShade(): string {
	return `am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1`;
}

/**
 * 在按钮 action 中：收起状态栏 → 前置 Termux 窗口 → 执行用户意图 → 移除通知。
 * 点击通知默认在后台执行，不会自动弹出 Termux，需要 am start 前置。
 */
function frontTermux(action: string): string {
	return `${collapseShade()}; am start -n com.termux/.app.TermuxActivity >/dev/null 2>&1; ${action}; ${dismissCmd()}`;
}

// ---------- 通知审批 ----------
/** 轮询审批状态文件，等待用户在通知上点击「同意/拒绝」。 */
function waitForApproval(timeoutMs: number): Promise<"yes" | "no" | "timeout"> {
	return new Promise((resolve) => {
		const start = Date.now();
		const timer = setInterval(() => {
			try {
				if (existsSync(APPROVE_FILE)) {
					const data = JSON.parse(readFileSync(APPROVE_FILE, "utf8"));
					clearInterval(timer);
					unlinkSync(APPROVE_FILE);
					resolve(data.choice === "yes" ? "yes" : "no");
					return;
				}
			} catch {
				/* 文件未就绪或损坏，忽略继续轮询 */
			}
			if (Date.now() - start > timeoutMs) {
				clearInterval(timer);
				resolve("timeout");
			}
		}, 300);
	});
}

/** 发送带「同意/拒绝」按钮的审批通知。 */
function notifyApproval(command: string): void {
	// 同意/拒绝后：前置 Termux 窗口并提示，让用户看到 Pi 继续处理。
	const writeYes = frontTermux(`echo '{"choice":"yes"}' > '${APPROVE_FILE}'; termux-toast '已同意'`);
	const writeNo = frontTermux(`echo '{"choice":"no"}' > '${APPROVE_FILE}'; termux-toast '已拒绝'`);
	notify(
		"Pi 需要审批",
		command.length > 200 ? `${command.slice(0, 200)}…` : command,
		[
			"--button1", "同意", "--button1-action", writeYes,
			"--button2", "拒绝", "--button2-action", writeNo,
			"--ongoing",
		],
		true,
	);
}

// ---------- 扩展 ----------
export default function (pi: ExtensionAPI) {
	// 1) 记录最后一次 agent 运行的结局，用于在 agent_settled 时区分中止原因。
	let lastOutcome: AgentActivityOutcome = "completed";
	pi.on("agent_before_settle", (event) => {
		lastOutcome = event.outcome;
	});

	// 2) agent 运行完全结束、等待输入时通知。
	pi.on("agent_settled", (event) => {
		const title =
			lastOutcome === "aborted"
				? "Pi 已中止"
				: lastOutcome === "error"
					? "Pi 运行出错"
					: "Pi 任务完成";
		// 正常完成/出错：只显示标题，不带「等待你的输入」提示，也不需要「查看」按钮；
		// 点击通知主体仍会前置 Termux（notify 默认行为）。
		if (lastOutcome === "aborted") {
			notify(
				title,
				"用户已中止会话",
				["--button1", "继续会话", "--button1-action", frontTermux(":")],
			);
			return;
		}
		notify(title, "");
	});

	// 2) Pi 弹出交互对话框（其他扩展的审批/确认/输入）时通知。
	pi.on("ui_prompt_start", (event: UIPromptStartEvent) => {
		const kindLabel: Record<string, string> = {
			confirm: "需要审批/确认",
			select: "需要选择",
			input: "需要输入",
			editor: "需要编辑",
			custom: "需要操作",
		};
		notify(
			`Pi ${kindLabel[event.kind] ?? "等待操作"}`,
			event.title ?? "请回到 Pi 会话处理",
			["--button1", "去处理", "--button1-action", frontTermux(":")],
			event.kind === "confirm", // 审批/确认类弹窗：带提示音和震动。
		);
	});

	// 3) 需要审批的危险命令：用通知按钮直接审批（同意/拒绝），不弹对话框。
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (!APPROVE_ENABLED || event.toolName !== "bash") return undefined;
		const command = String((event.input as { command?: unknown })?.command ?? "");
		const needsApproval = APPROVE_PATTERNS.some((re) => re.test(command));
		if (!needsApproval) return undefined;

		if (!ctx.hasUI) {
			return { block: true, reason: "危险命令已阻止（无 UI 审批，fail-closed）" };
		}

		notifyApproval(command);
		const decision = await waitForApproval(APPROVE_TIMEOUT_MS);
		removeNotification();

		if (decision === "yes") return undefined; // 放行
		return { block: true, reason: decision === "timeout" ? "审批超时，已阻止" : "用户拒绝" };
	});

	// 4) 长时间运行的工具（如 bash）结束时可通知。
	pi.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
		if (event.parentToolCallId) return; // 跳过嵌套调用（如 codemode 内的调用）
		if (typeof event.durationMs !== "number" || event.durationMs < THRESHOLD_MS) return;
		const status = event.isError ? "失败" : "完成";
		const secs = (event.durationMs / 1000).toFixed(0);
		notify(`命令${status}: ${event.toolName}`, `耗时 ${secs}s`);
	});

	// 5) 演示：注册一个 /termux-notify 命令，手动触发测试通知。
	pi.registerCommand("termux-notify", {
		description: "发送一个测试通知（Termux API）",
		handler: async (args, _ctx) => {
			const [title, ...rest] = (args ?? "").split(" ");
			notify(title || "Pi 测试通知", rest.join(" ") || "通知测试成功");
		},
	});
}
