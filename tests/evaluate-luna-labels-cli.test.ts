import { describe, expect, it } from "vitest";
import { evaluatorExitCode } from "../scripts/evaluate-luna-labels.js";

describe("Luna evaluator CLI pilot status", () => {
  it("accepts only a structurally validated agent-reference pilot that remains unverified", () => {
    expect(evaluatorExitCode({ mode: "luna-agent-reference-pilot", status: "UNVERIFIED" }, true)).toBe(0);
    expect(evaluatorExitCode({ mode: "luna-agent-reference-pilot", status: "FAIL" }, true)).toBe(2);
    expect(evaluatorExitCode({ mode: "luna-final-categorical-evaluation", status: "UNVERIFIED" }, true)).toBe(2);
    expect(evaluatorExitCode({ mode: "luna-final-categorical-evaluation", status: "PASS" }, true)).toBe(2);
  });

  it("keeps the default command strict for every unverified report", () => {
    expect(evaluatorExitCode({ mode: "luna-agent-reference-pilot", status: "UNVERIFIED" }, false)).toBe(2);
    expect(evaluatorExitCode({ mode: "luna-final-categorical-evaluation", status: "UNVERIFIED" }, false)).toBe(2);
    expect(evaluatorExitCode({ mode: "luna-final-categorical-evaluation", status: "FAIL" }, false)).toBe(2);
    expect(evaluatorExitCode({ mode: "luna-final-categorical-evaluation", status: "PASS" }, false)).toBe(0);
  });
});
