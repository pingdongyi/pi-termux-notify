/**
 * Termux Notification Hook Extension
 *
 * Combines Pi lifecycle hooks with the Termux API (termux-notification):
 *   - `agent_settled`: notify when the agent has fully finished running (waiting for input).
 *   - `ui_prompt_start`: notify when Pi shows an interactive dialog (approve/confirm/input).
 *   - `tool_execution_end`: notify when a tool finishes running past a threshold.
 *   - `tool_call`: route dangerous-command approvals through notification buttons (approve/reject),
 *     no need to switch back to the terminal. The decision is sent back via a status file.
 *
 * Configuration (environment variables):
 *   - PI_TERMUX_NOTIFY=off            Fully disable notifications (enabled by default).
 *   - PI_TERMUX_NOTIFY_THRESHOLD_MS=60000  Long-task threshold (ms, default 60000).
 *   - PI_TERMUX_NOTIFY_PRIORITY=high  Notification priority.
 *   - PI_TERMUX_NOTIFY_ID=pi          Notification id.
 *   - PI_APPROVE=on                   Enable notification approval (default on; off disables).
 *   - PI_APPROVE_PATTERNS=...         Approval match regexes (| separated), default dangerous-command set.
 *   - PI_APPROVE_TIMEOUT_MS=120000    Approval timeout (ms); on timeout it rejects (fail-closed).
 *
 * Loading:
 *   - Place at ~/.pi/agent/extensions/termux-notify.ts for auto-discovery; or
 *   - pi --extension ./termux-notify.ts to load manually.
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

// ---------- Configuration ----------
const DISABLED = ["0", "off", "false"].includes((process.env.PI_TERMUX_NOTIFY ?? "").toLowerCase());
const THRESHOLD_MS = Number(process.env.PI_TERMUX_NOTIFY_THRESHOLD_MS ?? 60000);
const NOTIFY_ID = process.env.PI_TERMUX_NOTIFY_ID ?? "pi";
const PRIORITY = process.env.PI_TERMUX_NOTIFY_PRIORITY ?? "high";

const APPROVE_ENABLED = !["0", "off", "false"].includes((process.env.PI_APPROVE ?? "on").toLowerCase());
const APPROVE_TIMEOUT_MS = Number(process.env.PI_APPROVE_TIMEOUT_MS ?? 120000);
const APPROVE_FILE = join(process.env.HOME ?? "", ".pi", "agent", "approval.json");
// Multiple patterns are separated by semicolons (a pattern may contain |, e.g. (-rf?|--recursive)).
const APPROVE_PATTERNS = (
	process.env.PI_APPROVE_PATTERNS ??
	"\\bsudo\\b;\\brm\\s+(-rf?|--recursive)\\b;\\b(chmod|chown)\\b.*777"
)
	.split(";")
	.filter(Boolean)
	.map((p) => new RegExp(p, "i"));

// ---------- Notifications ----------
/**
 * Send a system notification via the Termux API (runs in background, non-blocking).
 * Only add --action to the notification body when there are no buttons (clicking the
 * body fronts the Termux window); when there are buttons, rely on button actions and
 * do not add an action to the body to avoid conflicts.
 */
function notify(title: string, content: string, buttons: string[] = [], alert = false): void {
	if (DISABLED) return;
	const args = ["-t", title, "-c", content, "--priority", PRIORITY, "-i", NOTIFY_ID];
	// Critical notifications requiring a user response (approval etc.): add sound and vibration so they are not missed.
	if (alert) args.push("--sound", "--vibrate", "500,1000,200");
	if (buttons.length > 0) {
		args.push(...buttons);
	} else {
		// No buttons: clicking the notification body collapses the status bar, fronts Termux, and removes the notification.
		args.push("--action", `${collapseShade()}; am start -n com.termux/.app.TermuxActivity >/dev/null 2>&1; ${dismissCmd()}`);
	}
	execFile("termux-notification", args, { timeout: 5000 }, (err) => {
		if (err) console.error(`[termux-notify] notification failed: ${err.message}`);
	});
}

/** Remove the notification (cleanup after approval completes). */
function removeNotification(): void {
	if (DISABLED) return;
	execFile("termux-notification-remove", [NOTIFY_ID], { timeout: 5000 }, () => {});
}

/** Command fragment to remove the notification (cleanup after clicking, to avoid leftovers). */
function dismissCmd(): string {
	return `termux-notification-remove ${NOTIFY_ID} >/dev/null 2>&1`;
}

/** Collapse the status bar (notification shade). `cmd statusbar collapse` requires EXPAND_STATUS_BAR permission, which Termux lacks; the system broadcast is the most reliable. */
function collapseShade(): string {
	return `am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1`;
}

/**
 * In button actions: collapse the status bar -> front the Termux window -> run the user's intent -> remove the notification.
 * Clicking a notification runs in the background by default and does not bring up Termux; use am start to front it.
 */
function frontTermux(action: string): string {
	return `${collapseShade()}; am start -n com.termux/.app.TermuxActivity >/dev/null 2>&1; ${action}; ${dismissCmd()}`;
}

// ---------- Notification approval ----------
/** Poll the approval status file, waiting for the user to click Approve/Reject on the notification. */
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
				/* File not ready or corrupted, ignore and keep polling */
			}
			if (Date.now() - start > timeoutMs) {
				clearInterval(timer);
				resolve("timeout");
			}
		}, 300);
	});
}

/** Send an approval notification with Approve/Reject buttons. */
function notifyApproval(command: string): void {
	// After approve/reject: front the Termux window and show a toast so the user sees Pi continue processing.
	const writeYes = frontTermux(`echo '{"choice":"yes"}' > '${APPROVE_FILE}'; termux-toast 'Approved'`);
	const writeNo = frontTermux(`echo '{"choice":"no"}' > '${APPROVE_FILE}'; termux-toast 'Rejected'`);
	notify(
		"Pi needs approval",
		command.length > 200 ? `${command.slice(0, 200)}...` : command,
		[
			"--button1", "Approve", "--button1-action", writeYes,
			"--button2", "Reject", "--button2-action", writeNo,
			"--ongoing",
		],
		true,
	);
}

// ---------- Extension ----------
export default function (pi: ExtensionAPI) {
	// 1) Record the outcome of the last agent run, used to distinguish abort reasons in agent_settled.
	let lastOutcome: AgentActivityOutcome = "completed";
	pi.on("agent_before_settle", (event) => {
		lastOutcome = event.outcome;
	});

	// 2) Notify when the agent has fully finished running and is waiting for input.
	pi.on("agent_settled", (event) => {
		const title =
			lastOutcome === "aborted"
				? "Pi aborted"
				: lastOutcome === "error"
					? "Pi error"
					: "Pi task complete";
		// Normal completion/error: only show the title, with no "waiting for your input" hint and no "view" button;
		// clicking the notification body still fronts Termux (notify default behavior).
		if (lastOutcome === "aborted") {
			notify(
				title,
				"Session aborted by user",
				["--button1", "Resume", "--button1-action", frontTermux(":")],
			);
			return;
		}
		notify(title, "");
	});

	// 2) Notify when Pi shows an interactive dialog (approval/confirmation/input from other extensions).
	pi.on("ui_prompt_start", (event: UIPromptStartEvent) => {
		const kindLabel: Record<string, string> = {
			confirm: "needs confirmation",
			select: "needs a selection",
			input: "needs input",
			editor: "needs editing",
			custom: "needs action",
		};
		notify(
			`Pi ${kindLabel[event.kind] ?? "is waiting"}`,
			event.title ?? "Return to the Pi session to continue",
			["--button1", "Review", "--button1-action", frontTermux(":")],
			event.kind === "confirm", // Confirm-type dialogs: add sound and vibration.
		);
	});

	// 3) Dangerous commands needing approval: approve/reject directly via notification buttons, no dialog.
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (!APPROVE_ENABLED || event.toolName !== "bash") return undefined;
		const command = String((event.input as { command?: unknown })?.command ?? "");
		const needsApproval = APPROVE_PATTERNS.some((re) => re.test(command));
		if (!needsApproval) return undefined;

		if (!ctx.hasUI) {
			return { block: true, reason: "Dangerous command blocked (no UI for approval, fail-closed)" };
		}

		notifyApproval(command);
		const decision = await waitForApproval(APPROVE_TIMEOUT_MS);
		removeNotification();

		if (decision === "yes") return undefined; // allow through
		return { block: true, reason: decision === "timeout" ? "Approval timed out, blocked" : "Rejected by user" };
	});

	// 4) Notify when a long-running tool (e.g. bash) finishes.
	pi.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
		if (event.parentToolCallId) return; // skip nested calls (e.g. calls within codemode)
		if (typeof event.durationMs !== "number" || event.durationMs < THRESHOLD_MS) return;
		const status = event.isError ? "failed" : "completed";
		const secs = (event.durationMs / 1000).toFixed(0);
		notify(`Command ${status}: ${event.toolName}`, `Took ${secs}s`);
	});

	// 5) Demo: register a /termux-notify command to manually trigger a test notification.
	pi.registerCommand("termux-notify", {
		description: "Send a test notification (Termux API)",
		handler: async (args, _ctx) => {
			const [title, ...rest] = (args ?? "").split(" ");
			notify(title || "Pi test notification", rest.join(" ") || "Notification test succeeded");
		},
	});
}
