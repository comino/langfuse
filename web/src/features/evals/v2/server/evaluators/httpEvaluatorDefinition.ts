import { z } from "zod";
import {
  EvalTemplateType,
  InvalidRequestError,
  getCodeEvalVariableMapping,
} from "@langfuse/shared";
import { type PrismaClient } from "@langfuse/shared/src/db";
import { encrypt, generateWebhookSecret } from "@langfuse/shared/encryption";
import { type HttpEvalEndpoint } from "@langfuse/shared/src/server";
export { toHttpSetupDefinition as toHttpDefinition } from "@/src/features/evals/v2/fns/evaluators/httpSetupDefinition";
import type {
  EvaluatorDefinition,
  EvaluatorDefinitionForPersistence,
} from "./evaluatorTypes";

type HttpDefinition = Extract<EvaluatorDefinition, { type: "HTTP" }>;
type HttpPersistence = Extract<
  EvaluatorDefinitionForPersistence,
  { type: "HTTP" }
>;
type StoredHeaders = Record<string, { secret: boolean; value: string }>;
export type StoredHttpSecrets = {
  httpRequestHeaders: unknown;
  httpSecretKey: string | null;
};

const StoredHeadersSchema = z.record(
  z.string(),
  z.object({ secret: z.boolean(), value: z.string() }),
);
const parseStoredHeaders = (value: unknown): StoredHeaders =>
  StoredHeadersSchema.catch({}).parse(value ?? {});

/**
 * Encrypts new secret values and keeps stored ones for secret headers sent
 * with an empty value. The signing secret is generated once and then kept.
 */
export function toHttpPersistence(
  definition: HttpDefinition,
  previous: StoredHttpSecrets | null,
): HttpPersistence {
  const stored = parseStoredHeaders(previous?.httpRequestHeaders);
  const httpRequestHeaders: StoredHeaders = {};
  const httpDisplayHeaders: StoredHeaders = {};
  for (const { name, value, secret } of definition.headers) {
    httpDisplayHeaders[name] = { secret, value: secret ? "" : value };
    if (!secret) {
      httpRequestHeaders[name] = { secret, value };
    } else if (value) {
      httpRequestHeaders[name] = { secret, value: encrypt(value) };
    } else if (stored[name]?.secret) {
      httpRequestHeaders[name] = stored[name];
    } else {
      throw new InvalidRequestError(
        `Enter a value for secret header "${name}"`,
      );
    }
  }

  const generated = previous?.httpSecretKey
    ? null
    : generateWebhookSecret().secretKey;
  return {
    type: EvalTemplateType.HTTP,
    variableMapping: getCodeEvalVariableMapping(),
    httpUrl: definition.url,
    httpRequestHeaders,
    httpDisplayHeaders,
    httpSecretKey: previous?.httpSecretKey ?? encrypt(generated!),
    ...(generated ? { newSigningSecret: generated } : {}),
  };
}

export function toHttpEndpoint(persistence: HttpPersistence): HttpEvalEndpoint {
  return {
    url: persistence.httpUrl,
    storedHeaders: persistence.httpRequestHeaders,
    encryptedSecretKey: persistence.httpSecretKey,
  };
}

/** Reads the secrets the global Prisma omit hides from every other query. */
export async function findHttpSecrets(
  prisma: Pick<PrismaClient, "evaluatorVersion">,
  versionId: string | undefined,
): Promise<StoredHttpSecrets | null> {
  if (!versionId) return null;
  return prisma.evaluatorVersion.findUnique({
    where: { id: versionId },
    select: { httpRequestHeaders: true, httpSecretKey: true },
  });
}
