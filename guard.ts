/**
 * Pure decision + rendering logic for pi-todo-reminder.
 *
 * Kept free of Pi imports so the infinite-loop guard (the high-risk part of
 * this extension) is unit-testable without a Pi runtime.
 */

/** Minimal structural mirror of rpiv-todo's Task (tool/types.ts:39). */
export interface Task {
	id: number;
	subject: string;
	status: TaskStatus;
}

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

/** Tasks still requiring work: pending + in_progress. Tombstones and completed are excluded. */
export function incompleteTasks(tasks: readonly Task[]): Task[] {
	return tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
}

/**
 * Signature of the incomplete-task set: `id:status` pairs, order-independent.
 * Unchanged signature across two settled runs means the agent did no todo
 * work in between — the core infinite-loop guard.
 */
export function signatureOf(tasks: readonly Task[]): string {
	return incompleteTasks(tasks)
		.map((t) => `${t.id}:${t.status}`)
		.sort()
		.join(",");
}

/**
 * Stop-marker the model can emit to veto auto-continuation. Matched as a loose
 * substring (survives code fences / surrounding whitespace variations).
 */
export const REMINDER_STOP_MARKER = "todo-reminder:stop";

/** Why a settle chose not to remind (set when remind=false). */
export type SuppressReason = "aborted" | "stopped" | "no_progress" | "all_done";

export interface RemindVerdict {
	remind: boolean;
	/** Signature to store as "last reminded". `undefined` resets the guard. */
	nextSignature: string | undefined;
	/** Suppression reason; `undefined` when remind=true. */
	reason: SuppressReason | undefined;
}

/**
 * Full settle-time decision (pure): abort short-circuits, a stop request
 * (user interjection OR the model's own stop marker) silences this settle
 * while aligning the baseline (chain reset), empty list resets, unchanged
 * signature silences, everything else reminds.
 */
export function shouldRemind(
	tasks: readonly Task[],
	lastSignature: string | undefined,
	aborted: boolean,
	stopRequested = false,
): RemindVerdict {
	if (aborted) return { remind: false, nextSignature: undefined, reason: "aborted" };
	const sig = signatureOf(tasks);
	if (stopRequested) return { remind: false, nextSignature: sig, reason: "stopped" };
	if (incompleteTasks(tasks).length === 0) return { remind: false, nextSignature: undefined, reason: "all_done" };
	if (sig === lastSignature) return { remind: false, nextSignature: sig, reason: "no_progress" };
	return { remind: true, nextSignature: sig, reason: undefined };
}

/** Render one task line: `- #2 写测试` (group header carries the status). */
function formatTaskLine(t: Task): string {
	return `- #${t.id} ${t.subject}`;
}

/**
 * Reminder message body. in_progress first (the agent should finish what it
 * started), then pending, each group by id. `renderReminderContent` is only
 * called when `shouldRemind` returned remind=true, i.e. the list is non-empty.
 */
export function renderReminderContent(tasks: readonly Task[], includeCodemodeHint = false): string {
	const inProgress = incompleteTasks(tasks)
		.filter((t) => t.status === "in_progress")
		.sort((a, b) => a.id - b.id);
	const pending = incompleteTasks(tasks)
		.filter((t) => t.status === "pending")
		.sort((a, b) => a.id - b.id);
	const taskSection: string[] = [];
	if (inProgress.length > 0) {
		taskSection.push("进行中：", ...inProgress.map(formatTaskLine));
	}
	if (pending.length > 0) {
		taskSection.push("待办：", ...pending.map(formatTaskLine));
	}
	const requirements: string[] = [];
	if (includeCodemodeHint) {
		requirements.push("能用 codemode 批量完成的步骤，优先用 codemode 一次完成，而不是逐个调用工具。");
	}
	requirements.push("如果某个任务被阻塞或无法继续，说明原因并用 todo 工具记录（如 blockedBy 或 metadata）。");
	const numbered = requirements.map((r, i) => `${i + 1}. ${r}`);
	numbered.push(
		`${numbered.length + 1}. 如果判断不应再自动续跑（如用户已接管或要求停止、任务受阻），请在回复最后一行输出 \`<!-- ${REMINDER_STOP_MARKER} -->\`，系统将停止提醒；否则不要输出。`,
	);
	return [
		"[自动提醒] 本次运行已结束，但 todo 列表仍有未完成任务，请继续执行：",
		"",
		...taskSection,
		"",
		"要求：",
		...numbered,
	].join("\n");
}
