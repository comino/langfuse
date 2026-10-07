import { z } from "zod";
import { env } from "../../env";
import { decrypt } from "../../encryption";
import { RequestHeaderSchema } from "../../domain/automations";
import type { EvalExecutionContext } from "../../features/evals/evalExecutionMetadata";
import {
  LangfuseInternalTraceEnvironment,
  type InternalTraceWriter,
} from "../llm/types";
import {
  CircularRedirectError,
  fetchWithSecureRedirects,
  MaxRedirectsExceededError,
  OutboundUrlValidationError,
  RedirectValidationError,
  type OutboundUrlValidationWhitelist,
} from "../outbound-url";
import {
  buildWebhookRequestHeaders,
  type RequestHeaders,
} from "../utils/headerUtils";
import { validateWebhookURL } from "../webhooks/validation";
import {
  CODE_EVAL_DISPATCH_PAYLOAD_MAX_BYTES,
  CODE_EVAL_DISPATCH_RESULT_MAX_BYTES,
  CodeEvalDispatcherError,
  CodeEvalDispatcherErrorCodes,
  parseDispatchResult,
  type CodeEvalPayload,
  type DispatchResult,
} from "./codeEvalDispatcherTypes";
import {
  runEvaluationDispatch,
  type EvaluationDispatchResult,
} from "./codeEvalExecution";
import type { ExtractedVariable } from "./extractObservationVariables";

const HTTP_EVAL_LOG_CONTEXT = "HttpEval";
const StoredHeadersSchema = z.record(z.string(), RequestHeaderSchema);

export type HttpEvalEndpoint = {
  url: string;
  /** Stored request headers (secret values encrypted). */
  storedHeaders: unknown;
  /** Encrypted HMAC signing secret, or null to send unsigned. */
  encryptedSecretKey: string | null;
};

export type HttpEvalRequestBody = {
  evaluator: { id: string; name: string; version: number };
  execution: {
    jobExecutionId: string;
    traceId: string | null;
    observationId: string | null;
  };
  payload: CodeEvalPayload;
};

export function isHttpEvalEnabled(): boolean {
  return env.LANGFUSE_HTTP_EVAL_ENABLED === "true";
}

const httpEvalWhitelist = (): OutboundUrlValidationWhitelist => ({
  hosts: env.LANGFUSE_HTTP_EVAL_WHITELISTED_HOST,
  ips: env.LANGFUSE_HTTP_EVAL_WHITELISTED_IPS,
  ip_ranges: env.LANGFUSE_HTTP_EVAL_WHITELISTED_IP_SEGMENTS,
});

/** SSRF check for HTTP eval endpoints, with its own allowlist and ports. */
export function validateHttpEvalUrl(url: string): Promise<void> {
  return validateWebhookURL(url, httpEvalWhitelist(), {
    allowedPorts: env.LANGFUSE_HTTP_EVAL_ALLOWED_PORTS,
  });
}

/** Origin and path only: query strings may carry credentials. */
export function redactHttpEvalUrl(url: string): string {
  try {
    const { origin, pathname } = new URL(url);
    return `${origin}${pathname}`;
  } catch {
    return "[invalid url]";
  }
}

const dispatcherError = (
  code: keyof typeof CodeEvalDispatcherErrorCodes,
  message: string,
  options: { retryable?: boolean; cause?: unknown } = {},
) => new CodeEvalDispatcherError(message, { code, ...options });

const isRetryableStatus = (status: number) =>
  status === 408 || status === 429 || status >= 500;

/**
 * POSTs the eval payload to a user-configured endpoint and parses `{ scores }`.
 * Every failure is a `CodeEvalDispatcherError` with a message that never
 * contains the URL, header values or the response body.
 */
export async function sendHttpEvalRequest(params: {
  endpoint: HttpEvalEndpoint;
  body: HttpEvalRequestBody;
  timeoutMs?: number;
}): Promise<DispatchResult> {
  const { url } = params.endpoint;
  const timeoutMs = params.timeoutMs ?? env.LANGFUSE_HTTP_EVAL_TIMEOUT_MS;

  try {
    await validateHttpEvalUrl(url);
  } catch (error) {
    throw dispatcherError(
      "HTTP_URL_BLOCKED",
      "Evaluator endpoint is not allowed. Only public hosts on allowed ports can be called.",
      { cause: error },
    );
  }

  const body = JSON.stringify(params.body);
  if (Buffer.byteLength(body, "utf8") > CODE_EVAL_DISPATCH_PAYLOAD_MAX_BYTES) {
    throw dispatcherError(
      "HTTP_REQUEST_TOO_LARGE",
      `Evaluator request exceeds the ${CODE_EVAL_DISPATCH_PAYLOAD_MAX_BYTES} byte limit`,
    );
  }

  const { headers, sensitiveHeaderNames } = buildWebhookRequestHeaders({
    customHeaders: decryptStoredHeaders(params.endpoint.storedHeaders),
    body,
    signingSecret: decryptSigningSecret(params.endpoint.encryptedSecretKey),
  });

  const signal = AbortSignal.timeout(timeoutMs);
  let text: string;
  try {
    // Redirects are not followed: an eval endpoint has no reason to redirect,
    // and following one would re-send trace data to another target.
    const { response } = await fetchWithSecureRedirects(
      url,
      { method: "POST", body, headers, signal },
      {
        maxRedirects: 0,
        redirectValidation: {
          validateUrl: validateHttpEvalUrl,
          whitelist: httpEvalWhitelist(),
          logContext: HTTP_EVAL_LOG_CONTEXT,
        },
        additionalSensitiveHeaders: sensitiveHeaderNames,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw dispatcherError(
        "HTTP_STATUS_ERROR",
        `Evaluator endpoint returned HTTP ${response.status}`,
        { retryable: isRetryableStatus(response.status) },
      );
    }
    text = await readBodyWithLimit(
      response,
      CODE_EVAL_DISPATCH_RESULT_MAX_BYTES,
    );
  } catch (error) {
    throw toRequestError(error, timeoutMs);
  }

  // The response body is never echoed: the endpoint may be an allowlisted
  // internal host, and errors end up in user-visible traces.
  try {
    return parseDispatchResult(JSON.parse(text));
  } catch (error) {
    throw dispatcherError(
      "HTTP_INVALID_RESPONSE",
      "Evaluator endpoint returned an invalid result. Return JSON { scores: [...] } with at least one score; each score needs a name and a value matching its dataType.",
      { cause: error },
    );
  }
}

/** Fails closed: a request must never go out without its configured headers. */
function decryptStoredHeaders(storedHeaders: unknown): RequestHeaders {
  const parsed = StoredHeadersSchema.safeParse(storedHeaders ?? {});
  if (!parsed.success) {
    throw dispatcherError(
      "HTTP_INVALID_CONFIG",
      "Evaluator request headers are malformed. Re-save the evaluator.",
    );
  }
  const headers: RequestHeaders = {};
  for (const [name, header] of Object.entries(parsed.data)) {
    headers[name] = header.secret
      ? {
          secret: true,
          value: decryptOrThrow(header.value, "a request header"),
        }
      : header;
  }
  return headers;
}

function decryptSigningSecret(encrypted: string | null): string | undefined {
  return encrypted
    ? decryptOrThrow(encrypted, "the signing secret")
    : undefined;
}

function decryptOrThrow(value: string, what: string): string {
  try {
    return decrypt(value);
  } catch (error) {
    throw dispatcherError(
      "HTTP_INVALID_CONFIG",
      `Could not decrypt ${what} of the evaluator. Re-save the evaluator.`,
      { cause: error },
    );
  }
}

function toRequestError(error: unknown, timeoutMs: number) {
  if (error instanceof CodeEvalDispatcherError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return dispatcherError(
      "HTTP_TIMEOUT",
      `Evaluator endpoint did not respond within ${timeoutMs} ms`,
      { retryable: true, cause: error },
    );
  }
  if (findCause(error, (e) => e instanceof OutboundUrlValidationError)) {
    // Blocked at connection time, e.g. DNS rebinding to a private address.
    return dispatcherError(
      "HTTP_URL_BLOCKED",
      "Evaluator endpoint resolved to an address that is not allowed",
      { cause: error },
    );
  }
  if (
    error instanceof MaxRedirectsExceededError ||
    error instanceof CircularRedirectError ||
    error instanceof RedirectValidationError
  ) {
    return dispatcherError(
      "HTTP_URL_BLOCKED",
      "Evaluator endpoint responded with a redirect. Redirects are not followed; use the final URL.",
      { cause: error },
    );
  }
  const cause = findCause(
    error,
    (e) => typeof (e as { code?: unknown }).code === "string",
  ) as { code: string } | undefined;
  return dispatcherError(
    "HTTP_CONNECTION_ERROR",
    `Could not reach evaluator endpoint${cause ? ` (${cause.code})` : ""}`,
    { retryable: true, cause: error },
  );
}

function findCause(
  error: unknown,
  predicate: (e: object) => boolean,
): object | undefined {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (!current || typeof current !== "object") return undefined;
    if (predicate(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const tooLarge = () =>
    dispatcherError(
      "HTTP_RESPONSE_TOO_LARGE",
      `Evaluator response exceeds the ${maxBytes} byte limit`,
    );
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHttpEvaluationDispatch(params: {
  projectId: string;
  executionTraceId: string;
  jobExecutionId: string;
  evaluator: { id: string; name: string; version: number };
  target: { traceId: string | null; observationId: string | null };
  endpoint: HttpEvalEndpoint;
  extractedVariables: ExtractedVariable[];
  hasExperimentContext?: boolean;
  traceName: string;
  metadata: Record<string, unknown>;
  evaluationContext?: EvalExecutionContext;
  writeTrace?: InternalTraceWriter;
}): Promise<EvaluationDispatchResult> {
  return runEvaluationDispatch({
    ...params,
    environment: LangfuseInternalTraceEnvironment.HttpEval,
    traceMetadata: { http_eval_url: redactHttpEvalUrl(params.endpoint.url) },
    failureLabel: "HTTP eval execution failed",
    dispatch: (payload) =>
      sendHttpEvalRequest({
        endpoint: params.endpoint,
        body: {
          evaluator: params.evaluator,
          execution: {
            jobExecutionId: params.jobExecutionId,
            ...params.target,
          },
          payload,
        },
      }),
  });
}
