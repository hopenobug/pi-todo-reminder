import { describe, expect, it } from "vitest";
import { incompleteTasks, REMINDER_STOP_MARKER, renderReminderContent, shouldRemind, signatureOf, type Task } from "./guard.ts";

const t = (id: number, status: Task["status"], subject = `task ${id}`): Task => ({ id, subject, status });

describe("incompleteTasks", () => {
	it("keeps pending and in_progress", () => {
		const tasks = [t(1, "pending"), t(2, "in_progress"), t(3, "completed"), t(4, "deleted")];
		expect(incompleteTasks(tasks).map((x) => x.id)).toEqual([1, 2]);
	});

	it("returns empty for all-completed or empty input", () => {
		expect(incompleteTasks([t(1, "completed")])).toEqual([]);
		expect(incompleteTasks([])).toEqual([]);
	});
});

describe("signatureOf", () => {
	it("is order-independent", () => {
		expect(signatureOf([t(1, "pending"), t(2, "in_progress")])).toBe(signatureOf([t(2, "in_progress"), t(1, "pending")]));
	});

	it("ignores completed and deleted tasks", () => {
		const base = signatureOf([t(1, "pending")]);
		expect(signatureOf([t(1, "pending"), t(2, "completed"), t(3, "deleted")])).toBe(base);
	});

	it("changes when a status changes", () => {
		expect(signatureOf([t(1, "pending")])).not.toBe(signatureOf([t(1, "completed")]));
	});

	it("changes when a task is added", () => {
		expect(signatureOf([t(1, "pending")])).not.toBe(signatureOf([t(1, "pending"), t(2, "pending")]));
	});
});

describe("shouldRemind", () => {
	const tasks = [t(1, "in_progress"), t(2, "pending")];
	const sig = signatureOf(tasks);

	it("reminds on first settle with unfinished tasks", () => {
		expect(shouldRemind(tasks, undefined, false)).toEqual({ remind: true, nextSignature: sig, reason: undefined });
	});

	it("stays silent with reason no_progress when signature unchanged (infinite-loop guard)", () => {
		expect(shouldRemind(tasks, sig, false)).toEqual({ remind: false, nextSignature: sig, reason: "no_progress" });
	});

	it("reminds again after progress (a task completed)", () => {
		const progressed: Task[] = [t(1, "completed"), t(2, "pending")];
		expect(shouldRemind(progressed, sig, false).remind).toBe(true);
	});

	it("reminds again after a new task appears", () => {
		const grew: Task[] = [...tasks, t(3, "pending")];
		expect(shouldRemind(grew, sig, false).remind).toBe(true);
	});

	it("never reminds on abort and resets the signature", () => {
		expect(shouldRemind(tasks, undefined, true)).toEqual({ remind: false, nextSignature: undefined, reason: "aborted" });
		expect(shouldRemind(tasks, sig, true)).toEqual({ remind: false, nextSignature: undefined, reason: "aborted" });
	});

	it("does not remind when all done and resets the signature", () => {
		expect(shouldRemind([t(1, "completed")], sig, false)).toEqual({ remind: false, nextSignature: undefined, reason: "all_done" });
	});

	// Chain-stop requests ("静音一轮"): sources are a user interjection or
	// the model's own stop marker — same settle semantics either way.
	it("stays silent when stopped and aligns the baseline to the current signature", () => {
		expect(shouldRemind(tasks, sig, false, true)).toEqual({ remind: false, nextSignature: sig, reason: "stopped" });
	});

	it("silences the stop request even if the signature changed (agent made progress before stopping)", () => {
		const progressed: Task[] = [t(1, "completed"), t(2, "pending")];
		expect(shouldRemind(progressed, sig, false, true)).toEqual({ remind: false, nextSignature: signatureOf(progressed), reason: "stopped" });
	});

	it("resumes reminding after a stop request once the user asks to continue and the agent stops early again", () => {
		// 1. interruption settle: silent, baseline aligned
		const after = shouldRemind(tasks, sig, false, true);
		// 2. no work done → signature guard keeps it silent
		expect(shouldRemind(tasks, after.nextSignature, false).remind).toBe(false);
		// 3. agent makes progress then stops early → remind again
		const progressed: Task[] = [t(1, "completed"), t(2, "pending")];
		expect(shouldRemind(progressed, after.nextSignature, false).remind).toBe(true);
	});

	it("abort takes precedence over a stop request and resets the signature", () => {
		expect(shouldRemind(tasks, sig, true, true)).toEqual({ remind: false, nextSignature: undefined, reason: "aborted" });
	});

	it("behaves exactly as before when stopRequested is omitted (regression)", () => {
		expect(shouldRemind(tasks, undefined, false)).toEqual({ remind: true, nextSignature: sig, reason: undefined });
		expect(shouldRemind(tasks, sig, false)).toEqual({ remind: false, nextSignature: sig, reason: "no_progress" });
		expect(shouldRemind(tasks, undefined, true)).toEqual({ remind: false, nextSignature: undefined, reason: "aborted" });
	});
});

describe("renderReminderContent", () => {
	it("lists in_progress before pending with id/status/subject lines", () => {
		const content = renderReminderContent([t(5, "pending", "写文档"), t(2, "in_progress", "写测试"), t(9, "pending", "发布")]);
		expect(content).toContain("- #2 (in_progress) 写测试");
		expect(content.indexOf("#2")).toBeLessThan(content.indexOf("#5"));
		expect(content.indexOf("#5")).toBeLessThan(content.indexOf("#9"));
		expect(content).toContain("请继续执行");
	});

	it("includes the stop-marker instruction for the model to judge continuation", () => {
		const content = renderReminderContent([t(1, "pending")]);
		expect(content).toContain(REMINDER_STOP_MARKER);
		expect(content).toContain("不应再自动续跑");
	});
});
