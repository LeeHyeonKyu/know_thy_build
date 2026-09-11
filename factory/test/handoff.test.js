import { test, expect } from "vitest";
import { parseHandoffs, latestHandoff, renderHandoff } from "../lib/handoff.js";

const planBody = `<!-- factory-handoff:v1 stage=plan issue=123 -->
### Plan · round 3 합의

**접근**: 증분 동기화

\`\`\`json
{"schema":"factory.plan.v1","issue":123,"tier":"standard","done_when":[{"id":"dw1","text":"x","verify":"test_123_x","level":"unit"}]}
\`\`\`
`;

test("renderHandoff produces marker + summary + json fence, and parses back", () => {
  const body = renderHandoff({ stage: "plan", issue: 123, summary: "### Plan\n\n**접근**: 증분 동기화", data: { schema: "factory.plan.v1", issue: 123 } });
  expect(body.startsWith("<!-- factory-handoff:v1 stage=plan issue=123 -->")).toBe(true);
  expect(body).toContain("```json\n");
  const [h] = parseHandoffs([{ id: 1, body, createdAt: "2026-09-11T00:00:00Z" }]);
  expect(h.stage).toBe("plan");
  expect(h.issue).toBe(123);
  expect(h.data.schema).toBe("factory.plan.v1");
  expect(h.summary).toContain("**접근**");
});

test("parseHandoffs ignores non-handoff comments and malformed json", () => {
  const comments = [
    { id: 1, body: "just a comment", createdAt: "2026-09-11T00:00:00Z" },
    { id: 2, body: planBody, createdAt: "2026-09-11T00:01:00Z" },
    { id: 3, body: "<!-- factory-handoff:v1 stage=plan issue=123 -->\n```json\n{not json\n```", createdAt: "2026-09-11T00:02:00Z" },
  ];
  const hs = parseHandoffs(comments);
  expect(hs).toHaveLength(1);
  expect(hs[0].commentId).toBe(2);
});

test("latestHandoff returns the newest for a stage by createdAt", () => {
  const older = { id: 1, body: planBody.replace('"tier":"standard"', '"tier":"docs"'), createdAt: "2026-09-10T00:00:00Z" };
  const newer = { id: 2, body: planBody, createdAt: "2026-09-11T00:00:00Z" };
  expect(latestHandoff([newer, older], "plan").data.tier).toBe("standard");
  expect(latestHandoff([older], "review")).toBe(null);
});
