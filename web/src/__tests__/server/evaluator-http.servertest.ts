import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EvalTemplateType, InvalidRequestError } from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import { decrypt } from "@langfuse/shared/encryption";
import { createOrgProjectAndApiKey } from "@langfuse/shared/src/server";

const flag = vi.hoisted(() => ({ httpEnabled: true }));
vi.mock("@langfuse/shared/src/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langfuse/shared/src/server")>()),
  isHttpEvalEnabled: () => flag.httpEnabled,
}));
import { EvaluatorService } from "@/src/features/evals/v2/server/evaluators/evaluatorService";
import { LegacyEvalCompatibilityService } from "@/src/features/evals/server/legacyCompatibilityService";
import { toPublicEvaluator } from "@/src/features/public-api/server/evaluation/evaluationAdapters";
import { EvaluatorConfigurationError } from "@/src/features/evals/v2/server/evaluators/evaluatorErrors";

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
    ).rejects.toBeInstanceOf(EvaluatorConfigurationError);
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

describe("HTTP evaluator persistence", () => {
  // A public IP literal passes the SSRF check without a DNS lookup.
  const url = "https://93.184.215.14/score";
  const create = (
    headers: { name: string; value: string; secret: boolean }[],
  ) =>
    service.create(
      {
        projectId,
        name: `http-${randomUUID()}`,
        description: null,
        definition: { type: EvalTemplateType.HTTP, url, headers },
      },
      null,
    );
  const storedVersions = (id: string) =>
    prisma.evaluatorVersion.findMany({
      where: { evaluatorId: id },
      orderBy: { version: "asc" },
      select: { httpRequestHeaders: true, httpSecretKey: true },
    });
  const storedSecret = (version: { httpRequestHeaders: unknown }) =>
    decrypt(
      (version.httpRequestHeaders as Record<string, { value: string }>)[
        "x-api-key"
      ].value,
    );

  it("encrypts secrets at rest, returns the signing secret once and never reads secrets back", async () => {
    const created = await create([
      { name: "x-api-key", value: "k1", secret: true },
      { name: "x-team", value: "search", secret: false },
    ]);

    expect(created.signingSecret).toMatch(/^lf-whsec_/);
    const [stored] = await storedVersions(created.id);
    expect(storedSecret(stored)).toBe("k1");
    expect(decrypt(stored.httpSecretKey!)).toBe(created.signingSecret);

    const readBack = await service.get(projectId, created.id);
    expect(JSON.stringify(readBack)).not.toContain("k1");
    expect(JSON.stringify(readBack)).not.toContain(created.signingSecret!);
  });

  it("keeps a stored secret for an empty value and only versions real changes", async () => {
    const created = await create([
      { name: "x-api-key", value: "k1", secret: true },
    ]);
    const update = (value: string) =>
      service.update(
        {
          projectId,
          evaluatorId: created.id,
          name: created.name,
          description: null,
          definition: {
            type: EvalTemplateType.HTTP,
            url,
            headers: [{ name: "x-api-key", value, secret: true }],
          },
        },
        null,
      );

    await update("");
    expect(await storedVersions(created.id)).toHaveLength(1);

    await update("k2");
    const versions = await storedVersions(created.id);
    expect(versions.map(storedSecret)).toEqual(["k1", "k2"]);
    expect(versions[1].httpSecretKey).toBe(versions[0].httpSecretKey);
  });

  it.each([
    [
      "a new secret header without a value",
      [{ name: "x-api-key", value: "", secret: true }],
      undefined,
      InvalidRequestError,
    ],
    ["a private address", [], "http://10.0.0.5/score", InvalidRequestError],
    ["a disabled feature", [], undefined, EvaluatorConfigurationError],
  ])("rejects %s", async (label, headers, badUrl, errorType) => {
    flag.httpEnabled = label !== "a disabled feature";
    try {
      await expect(
        service.create(
          {
            projectId,
            name: `http-${randomUUID()}`,
            description: null,
            definition: {
              type: EvalTemplateType.HTTP,
              url: badUrl ?? url,
              headers,
            },
          },
          null,
        ),
      ).rejects.toBeInstanceOf(errorType);
    } finally {
      flag.httpEnabled = true;
    }
  });
});
