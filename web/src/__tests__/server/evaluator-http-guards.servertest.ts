import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EvalTemplateType, InvalidRequestError } from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import { createOrgProjectAndApiKey } from "@langfuse/shared/src/server";
import { EvaluatorService } from "@/src/features/evals/v2/server/evaluators/evaluatorService";
import { LegacyEvalCompatibilityService } from "@/src/features/evals/server/legacyCompatibilityService";
import { toPublicEvaluator } from "@/src/features/public-api/server/evaluation/evaluationAdapters";

// HTTP evaluators can exist before the web can create them. Web paths must
// never leak their secrets, crash, or lose their endpoint config.
let orgId = "";
let projectId = "";
let evaluatorId = "";
let versionId = "";
const service = new EvaluatorService(
  prisma,
  vi.fn(async () => undefined),
);
const legacy = new LegacyEvalCompatibilityService(prisma);

const createLegacyRule = () =>
  prisma.evaluationRule.create({
    data: {
      projectId,
      name: `rule-${randomUUID()}`,
      targetObject: "trace",
      filter: [],
      sampling: 1,
      delay: 0,
      assignments: { create: { projectId, evaluatorId } },
    },
  });

beforeAll(async () => {
  const { org, project } = await createOrgProjectAndApiKey();
  orgId = org.id;
  projectId = project.id;
  const evaluator = await prisma.evaluator.create({
    data: {
      projectId,
      name: "http-evaluator",
      type: EvalTemplateType.HTTP,
      blockedAt: new Date(),
      versions: {
        create: {
          version: 1,
          httpUrl: "https://evals.example.com/score",
          httpRequestHeaders: { "x-api-key": { secret: true, value: "enc" } },
          httpSecretKey: "enc-secret",
        },
      },
    },
    include: { versions: true },
  });
  evaluatorId = evaluator.id;
  versionId = evaluator.versions[0].id;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } });
});

describe("HTTP evaluators on web paths", () => {
  it("never returns the encrypted columns", async () => {
    const serialized = JSON.stringify(
      await service.get(projectId, evaluatorId),
    );
    expect(serialized).not.toContain("enc-secret");
    expect(serialized).not.toContain('"enc"');
  });

  it("rejects unsupported paths with client errors instead of crashing", async () => {
    const evaluator = await service.get(projectId, evaluatorId);
    expect(() => toPublicEvaluator(evaluator)).toThrow(InvalidRequestError);
    await expect(
      service.reactivate({ projectId, evaluatorId }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(await legacy.getTemplate(projectId, versionId)).toBeNull();
  });

  it("refuses a legacy rename that would fork it without its endpoint", async () => {
    const rule = await createLegacyRule();
    await createLegacyRule();

    await expect(
      legacy.updateConfig({
        projectId,
        ruleId: rule.id,
        data: { scoreName: "renamed" },
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(
      await prisma.evaluator.count({
        where: { projectId, type: EvalTemplateType.HTTP },
      }),
    ).toBe(1);
  });
});
