/**
 * Structured per-node step buffer. Captures the ordered sequence of text
 * runs, tool calls, and shell steps emitted while a workflow node executes
 * so the run-view timeline can render a collapsible, chronological list
 * rather than a single opaque log blob.
 *
 * Text runs are capped at `PER_STEP_TEXT_CAP` bytes (UTF-16 length — fine
 * for the UI-side cap we care about) to prevent a runaway reasoning
 * stream from blowing out the `steps_json` column or the rendered card.
 */

import type { RunStep } from "../memory/workflow_runs.ts";

const PER_STEP_TEXT_CAP = 256 * 1024;

export class NodeStepBuffer {
  steps: RunStep[] = [];
  private currentText: RunStep | null = null;
  private currentTool: RunStep | null = null;
  private currentToolCallIndex: number | null = null;

  private closeText(): void {
    if (!this.currentText) return;
    this.currentText.durationMs = Date.now() - this.currentText.startedAt;
    this.steps.push(this.currentText);
    this.currentText = null;
  }

  private closeTool(): void {
    if (!this.currentTool) return;
    this.currentTool.durationMs = Date.now() - this.currentTool.startedAt;
    this.steps.push(this.currentTool);
    this.currentTool = null;
    this.currentToolCallIndex = null;
  }

  onText(channel: "content" | "reasoning", text: string): void {
    if (this.currentTool) return;
    if (this.currentText && this.currentText.label === channel) {
      const remaining =
        PER_STEP_TEXT_CAP - (this.currentText.output ?? "").length;
      if (remaining <= 0) return;
      this.currentText.output =
        (this.currentText.output ?? "") + text.slice(0, remaining);
      if (text.length > remaining) {
        this.currentText.output += "\n…truncated";
      }
    } else {
      this.closeText();
      this.currentText = {
        kind: "text",
        label: channel,
        output: text.slice(0, PER_STEP_TEXT_CAP),
        startedAt: Date.now(),
      };
    }
  }

  onToolCallDelta(
    callIndex: number,
    name: string | undefined,
    argsDelta: string,
  ): void {
    if (this.currentToolCallIndex !== callIndex) {
      this.closeText();
      this.closeTool();
      this.currentTool = {
        kind: "tool",
        label: name ?? "tool",
        summary: "",
        startedAt: Date.now(),
      };
      this.currentToolCallIndex = callIndex;
    }
    if (this.currentTool) {
      if (name && (!this.currentTool.label || this.currentTool.label === "tool")) {
        this.currentTool.label = name;
      }
      const sum = (this.currentTool.summary ?? "") + argsDelta;
      this.currentTool.summary = sum.slice(0, 512);
    }
  }

  onToolResult(
    name: string,
    ok: boolean,
    output: string,
    error?: string,
  ): void {
    if (!this.currentTool) {
      this.closeText();
      this.currentTool = {
        kind: "tool",
        label: name,
        startedAt: Date.now(),
      };
    } else if (!this.currentTool.label || this.currentTool.label === "tool") {
      this.currentTool.label = name;
    }
    this.currentTool.output = output;
    this.currentTool.ok = ok;
    if (error) this.currentTool.error = error;
    this.currentTool.durationMs = Date.now() - this.currentTool.startedAt;
    this.steps.push(this.currentTool);
    this.currentTool = null;
    this.currentToolCallIndex = null;
  }

  pushRaw(step: RunStep): void {
    this.closeText();
    this.closeTool();
    this.steps.push(step);
  }

  finalize(): RunStep[] {
    this.closeText();
    this.closeTool();
    return this.steps;
  }

  asLogText(): string {
    return this.steps
      .map((s) => {
        if (s.kind === "text") return s.output ?? "";
        if (s.kind === "tool") {
          return `\n[tool:${s.label ?? "?"}] ${s.ok ? "ok" : "error"}: ${
            s.output ?? s.error ?? ""
          }\n`;
        }
        return s.output ?? "";
      })
      .join("");
  }
}
