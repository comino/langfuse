import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createServer, type IncomingMessage } from "http";
import { randomUUID } from "crypto";
import { EvalTemplateType, JobExecutionStatus } from "@prisma/client";

const h = vi.hoisted(() => {
  // Allow the loopback test endpoint; env is parsed when shared is imported.
  process.env.LANGFUSE_HTTP_EVAL_WHITELISTED_IPS = "127.0.0.1";
  process.env.LANGFUSE_HTTP_EVAL_ALLOWED_PORTS = "any";
  return { observationJson: "", writeTrace: vi.fn() };
});

vi.mock("@langfuse/shared/src/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langfuse/shared/src/server")>()),
  isHttpEvalEnabled: () => true,
  writeInternalTraceViaOtelIngestion: h.writeTrace,
}));
vi.mock("../s3StorageClient", () => ({
  getEvalS3StorageClient: () => ({ download: async () => h.observationJson }),
}));

import { prisma } from "@langfuse/shared/src/db";
import {
  CodeEvalExecutionError,
  createOrgProjectAndApiKey,
  encryptSecretHeaders,
} from "@langfuse/shared/src/server";
import { encrypt, generateWebhookSignature } from "@langfuse/shared/encryption";
import { processObservationEval } from "../observationEval/observationEvalProcessor";
import { fetchObservationEvalRules } from "../observationEval/fetchObservationEvalRules";
import { codeEvalExecutionQueueProcessorBuilder } from "../../../queues/codeEvalQueue";
import {
  createMockProcessorDeps,
  createTestObservation,
} from "../observationEval/__tests__/fixtures";

const projectId = randomUUID();
const secret = "lf-whsec_db";
let status = 200;
const hits: { headers: IncomingMessage["headers"]; body: string }[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hits.push({ headers: req.headers, body });
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ scores: [{ name: "db", value: 1 }] }));
  });
});
let url = "";

async function seed() {
  const evaluator = await prisma.evaluator.create({
    data: {
      projectId,
      name: `http-${randomUUID()}`,
      type: EvalTemplateType.HTTP,
      versions: {
        create: {
          version: 1,
          // A stored mapping, even an empty one, must not strip the payload.
          variableMapping: [],
          httpUrl: `${url}?token=t0ken`,
          httpRequestHeaders: encryptSecretHeaders({
            "x-api-key": { secret: true, value: "db-key" },
          }),
          httpSecretKey: encrypt(secret),
        },
      },
    },
  });
  const rule = await prisma.evaluationRule.create({
    data: {
      projectId,
      name: "rule",
      targetObject: "event",
      filter: [],
      sampling: 1,
      delay: 0,
      assignments: {
        create: { projectId, evaluatorId: evaluator.id, variableMapping: [] },
      },
    },
  });
  const observation = createTestObservation({
    project_id: projectId,
    input: '{"question":"2+2"}',
    output: "4",
    experiment_id: "experiment-1",
    experiment_item_expected_output: "4",
  });
  h.observationJson = JSON.stringify(observation);
  const job = await prisma.jobExecution.create({
    data: {
      projectId,
      jobConfigurationId: rule.id,
      status: JobExecutionStatus.PENDING,
      jobInputTraceId: observation.trace_id,
      jobInputObservationId: observation.span_id,
    },
  });
  const event = {
    projectId,
    jobExecutionId: job.id,
    observationS3Path: "path",
    evaluatorId: evaluator.id,
    evaluationRuleId: rule.id,
  };
  return { evaluator, rule, job, event, observation };
}

beforeAll(async () => {
  await createOrgProjectAndApiKey({ projectId });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/s`;
});
beforeEach(() => {
  status = 200;
  hits.length = 0;
  h.writeTrace.mockReset();
});
afterAll(async () => {
  await prisma.project.delete({ where: { id: projectId } });
  await new Promise((r) => server.close(r));
});

describe("HTTP evaluator against real Postgres and a real endpoint", () => {
  it("delivers the full signed payload using secrets the global omit hides", async () => {
    const { evaluator, job, observation, event } = await seed();

    const outcome = await processObservationEval({
      event,
      executionType: EvalTemplateType.CODE,
      deps: createMockProcessorDeps({
        downloadObservationFromS3: vi.fn().mockResolvedValue(h.observationJson),
      }),
    });

    expect(outcome).toBe("completed");
    const [hit] = hits;
    expect(JSON.parse(hit.body)).toEqual({
      evaluator: { id: evaluator.id, name: evaluator.name, version: 1 },
      execution: {
        jobExecutionId: job.id,
        traceId: observation.trace_id,
        observationId: observation.span_id,
      },
      payload: {
        observation: {
          input: { question: "2+2" },
          output: "4",
          metadata: observation.metadata,
          toolCalls: [],
        },
        experiment: { itemExpectedOutput: "4", itemMetadata: null },
      },
    });
    expect(hit.headers["x-api-key"]).toBe("db-key");
    const [, ts, digest] = String(hit.headers["x-langfuse-signature"]).match(
      /^t=(\d+),v1=([0-9a-f]{64})$/,
    )!;
    expect(digest).toBe(generateWebhookSignature(hit.body, Number(ts), secret));

    const traceEvent = h.writeTrace.mock.calls[0][0].eventInputs[0];
    expect(traceEvent.environment).toBe("langfuse-http-eval");
    expect(traceEvent.metadata.http_eval_url).toBe(url);
    expect(JSON.stringify(traceEvent)).not.toContain("t0ken");
  });

  it("keeps the job pending for a retry when the endpoint returns 503", async () => {
    const { event, job } = await seed();
    status = 503;

    await expect(
      codeEvalExecutionQueueProcessorBuilder("q")({
        data: { payload: event },
        attemptsStarted: 1,
        attemptsMade: 0,
        opts: { attempts: 3 },
        timestamp: Date.now(),
      } as never),
    ).rejects.toBeInstanceOf(CodeEvalExecutionError);
    const row = await prisma.jobExecution.findUnique({ where: { id: job.id } });
    expect(row?.status).toBe(JobExecutionStatus.PENDING);
  });

  it("schedules HTTP rules", async () => {
    const { rule, evaluator } = await seed();
    const rules = await fetchObservationEvalRules(projectId);
    expect(
      rules
        .find((r) => r.id === rule.id)
        ?.assignments.map((a) => a.evaluatorId),
    ).toEqual([evaluator.id]);
  });
});
