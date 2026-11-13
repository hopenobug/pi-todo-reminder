/**
 * pi-todo-reminder — Pi extension.
 *
 * Tracks per-session todo snapshots from rpiv-todo's `todo` tool results
 * (public persistence contract: ToolResultMessage.details = TaskDetails,
 * details.tasks is the full task list incl. deleted tombstones). When an
 * agent run fully settles (agent_settled) with unfinished todos in THAT
 * session, injects a reminder custom message with triggerTurn so the agent
 * continues working.
 *
 * Infinite-loop guard: unchanged incomplete-set signature between settles
 * means the agent did no todo work — stay silent. Manual aborts (aborted:
 * true, e.g. Escape) never trigger a turn and stay fully silent. Every
 * OTHER suppression (stop request / no progress) emits a display-only note
 * with the reason (never triggers a turn), at most once per reminder
 * episode: any suppression resets the chain, and progress re-arms a
 * reminder naturally via the signature change. Abort (fully silent) and
 * all-done (natural completion) never emit a note.
 *
 * Session filtering: snapshots and reminder signatures are keyed by the
 * calling session id (ctx.sessionManager.getSessionId(), mirroring
 * rpiv-todo's sid()). A todo call from a child session only affects that
 * child's slot and can never trigger a reminder for the foreground session.
 * Slots are evicted on session_shutdown. A stale/throwing ctx (pi-core
 * invalidates ctx proxies during session replacement) resolves to "" — the
 * shared fallback slot, the same safe default rpiv-todo uses.
 *
 * Stop-judgment: the reminder itself instructs the model to emit the stop
 * marker (REMINDER_STOP_MARKER) when it judges auto-continuation should end
 * (user took over / asked to stop / task externally blocked). The model sees
 * everything in context, so it is the primary judge; the mechanical
 * user-message scan stays as a backstop. Both consume the same flag at the
 * next settle (silence + baseline align + chain reset).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	REMINDER_STOP_MARKER,
	renderReminderContent,
	shouldRemind,
	type SuppressReason,
	type Task,
} from "./guard.ts";

const TODO_TOOL_NAME = "todo";
const CODEMODE_TOOL_NAME = "codemode";
const REMINDER_CUSTOM_TYPE = "pi-todo-reminder";

/** rpiv-todo's TaskDetails.tasks, read from the ToolResultMessage envelope. */
type TodoToolResult = { details?: { tasks?: Task[] } };

interface SessionSlot {
	tasks: Task[];
	lastSignature: string | undefined;
	/** Reminder chain active (we sent the most recent reminder). */
	reminded: boolean;
	/** Chain-stop requested (user interjection or the model's stop marker); consumed at the next settle. */
	userInterrupted: boolean;
}

/** Human-readable reason for a suppressed reminder (shown in the passive note). */
const SUPPRESS_REASON_TEXT: Record<SuppressReason, string> = {
	aborted: "检测到手动中止，本次不自动续跑。",
	stopped: "检测到停止请求（用户插话或模型判定不应继续），已停止自动续跑。",
	no_progress: "todo 列表自上次提醒后无变化（任务无进展），本次不重复提醒。",
	all_done: "所有任务已完成，自动续跑结束。",
};

/** Best-effort session key: stale/throwing ctx proxies resolve to "". */
function sessionKey(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId() ?? "";
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	const slots = new Map<string, SessionSlot>();

	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName !== TODO_TOOL_NAME || event.isError) return;
		const tasks = (event.result as TodoToolResult | undefined)?.details?.tasks;
		if (!Array.isArray(tasks)) return;
		const key = sessionKey(ctx);
		const slot: SessionSlot = slots.get(key) ?? { tasks, lastSignature: undefined, reminded: false, userInterrupted: false };
		slot.tasks = tasks;
		slots.set(key, slot);
	});

	// User manually starts a run while our reminder chain is active → that
	// interjection overrides the chain. Only fires when reminded, so the
	// user's initial task prompt never counts as an interruption.
	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType !== "user") return;
		const slot = slots.get(sessionKey(ctx));
		if (slot?.reminded) slot.userInterrupted = true;
	});

	// A user message queued into a reminder-triggered run (typed while the
	// run was executing) never fires before_agent_start; it surfaces as a
	// role:"user" message in the run's messages instead. The model's own
	// stop marker in that run's assistant replies means it judged the chain
	// should end — same settle semantics, consumed together.
	pi.on("agent_end", (event, ctx) => {
		const slot = slots.get(sessionKey(ctx));
		if (!slot?.reminded) return;
		const modelSaidStop = event.messages.some(
			(m) =>
				m.role === "assistant" &&
				Array.isArray((m as { content?: Array<{ type?: string; text?: string }> }).content) &&
				(m as { content: Array<{ type?: string; text?: string }> }).content.some(
					(b) => b.type === "text" && typeof b.text === "string" && b.text.includes(REMINDER_STOP_MARKER),
				),
		);
		if (modelSaidStop || event.messages.some((m) => m.role === "user")) {
			slot.userInterrupted = true;
		}
	});

	pi.on("agent_settled", (event, ctx) => {
		const key = sessionKey(ctx);
		const slot = slots.get(key);
		// No todo activity in this session — nothing to remind about.
		if (!slot) return;
		const wasReminded = slot.reminded;
		const interrupted = slot.userInterrupted;
		slot.userInterrupted = false;
		const verdict = shouldRemind(slot.tasks, slot.lastSignature, event.aborted, interrupted);
		if (!verdict.remind) {
			slot.lastSignature = verdict.nextSignature;
			// Any suppression ends the reminder episode: progress changes the
			// signature and re-arms a reminder naturally, so nothing is lost.
			slot.reminded = false;
			// Passive reason note (display-only, never triggers a turn) — only
			// when a chain was actually active. Never on abort (manual stop must
			// stay fully silent) nor on all_done (natural completion needs no
			// closure note).
			const reason = verdict.reason;
			if (wasReminded && reason && reason !== "aborted" && reason !== "all_done") {
				try {
					pi.sendMessage({
						customType: REMINDER_CUSTOM_TYPE,
						content: `[自动提醒] ${SUPPRESS_REASON_TEXT[reason]}`,
						display: true,
						details: { sessionKey: key, reason, signature: verdict.nextSignature, tasks: slot.tasks },
					});
				} catch (error) {
					console.warn(`[pi-todo-reminder] failed to send suppress note: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return;
		}
		const content = renderReminderContent(slot.tasks, pi.getActiveTools().includes(CODEMODE_TOOL_NAME));
		try {
			// ExtensionAPI.sendMessage is fire-and-forget (void); triggerTurn
			// starts the follow-up run while idle. Record the signature before
			// returning so the run this spawns settles against it.
			pi.sendMessage(
				{
					customType: REMINDER_CUSTOM_TYPE,
					content,
					display: true,
					details: { sessionKey: key, signature: verdict.nextSignature, tasks: slot.tasks },
				},
				{ triggerTurn: true },
			);
			slot.lastSignature = verdict.nextSignature;
			slot.reminded = true;
		} catch (error) {
			// A failed reminder must not break Pi's lifecycle; signature stays
			// unchanged so the next settle retries the reminder.
			console.warn(`[pi-todo-reminder] failed to send reminder: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		slots.delete(sessionKey(ctx));
	});
}
