import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "http";
import { env } from "../../env";
import {
  redactHttpEvalUrl,
  sendHttpEvalRequest,
  validateHttpEvalUrl,
  type HttpEvalEndpoint,
} from "./httpEvalExecution";
import { CodeEvalDispatcherError } from "./codeEvalDispatcherTypes";
import { getCodeEvalUserVisibleError } from "./codeEvalExecution";
import { encrypt, generateWebhookSignature } from "../../encryption";
import { encryptSecretHeaders } from "../utils/headerUtils";

type Hit = { headers: IncomingMessage["headers"]; body: string };
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const servers: Server[] = [];
const mutableEnv = env as {
  LANGFUSE_HTTP_EVAL_WHITELISTED_IPS: string[];
  LANGFUSE_HTTP_EVAL_ALLOWED_PORTS: string[] | "any";
};
const originalEnv = { ...mutableEnv };

async function serve(handler: Handler) {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ headers: req.headers, body });
      handler(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { hits, url: `http://127.0.0.1:${port}/score` };
}

const respond =
  (status: number, payload: string): Handler =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  };
const okScores = respond(200, '{"scores":[{"name":"s","value":1}]}');

const body = {
  evaluator: { id: "ev", name: "n", version: 1 },
  execution: { jobExecutionId: "j", traceId: "t", observationId: "o" },
  payload: {
    observation: { input: "q", output: "a", metadata: null, toolCalls: [] },
  },
};
const endpoint = (url: string, extra: Partial<HttpEvalEndpoint> = {}) => ({
  url,
  storedHeaders: {},
  encryptedSecretKey: null,
  ...extra,
});

async function failure(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CodeEvalDispatcherError);
  return error as CodeEvalDispatcherError;
}

beforeEach(() => {
  // Real loopback sockets: allow 127.0.0.1 on any port for HTTP evals only.
  mutableEnv.LANGFUSE_HTTP_EVAL_WHITELISTED_IPS = ["127.0.0.1"];
  mutableEnv.LANGFUSE_HTTP_EVAL_ALLOWED_PORTS = "any";
});

afterEach(async () => {
  Object.assign(mutableEnv, originalEnv);
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

describe("sendHttpEvalRequest", () => {
  it("signs the exact bytes it sends and decrypts secret headers", async () => {
    const { hits, url } = await serve(okScores);
    const secret = "lf-whsec_test";

    const result = await sendHttpEvalRequest({
      endpoint: endpoint(url, {
        storedHeaders: encryptSecretHeaders({
          "x-api-key": { secret: true, value: "k1" },
        }),
        encryptedSecretKey: encrypt(secret),
      }),
      body,
    });

    expect(result.scores).toEqual([{ name: "s", value: 1 }]);
    const [hit] = hits;
    expect(JSON.parse(hit.body)).toEqual(body);
    expect(hit.headers["x-api-key"]).toBe("k1");
    const [, ts, digest] = String(hit.headers["x-langfuse-signature"]).match(
      /^t=(\d+),v1=([0-9a-f]{64})$/,
    )!;
    expect(digest).toBe(generateWebhookSignature(hit.body, Number(ts), secret));
  });

  it.each([
    [500, true],
    [429, true],
    [408, true],
    [404, false],
  ])("maps HTTP %s to retryable=%s", async (status, retryable) => {
    const { url } = await serve(respond(status, "{}"));
    const error = await failure(
      sendHttpEvalRequest({ endpoint: endpoint(url), body }),
    );
    expect(error.code).toBe("HTTP_STATUS_ERROR");
    expect(error.retryable).toBe(retryable);
  });

  it("times out a body that stalls after the headers as retryable", async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"scores":[');
    });
    const error = await failure(
      sendHttpEvalRequest({ endpoint: endpoint(url), body, timeoutMs: 300 }),
    );
    expect(error.code).toBe("HTTP_TIMEOUT");
    expect(error.retryable).toBe(true);
  });

  it("caps a streamed response without content-length", async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      for (let i = 0; i < 64; i++) res.write("x".repeat(64 * 1024));
      res.end();
    });
    const error = await failure(
      sendHttpEvalRequest({ endpoint: endpoint(url), body }),
    );
    expect(error.code).toBe("HTTP_RESPONSE_TOO_LARGE");
  });

  it("never echoes the response body of an invalid result", async () => {
    const { url } = await serve(respond(200, '{"admin_token":"s3cr3t"}'));
    const error = await failure(
      sendHttpEvalRequest({ endpoint: endpoint(url), body }),
    );
    expect(error.code).toBe("HTTP_INVALID_RESPONSE");
    expect(error.returnedResult).toBeUndefined();
    expect(JSON.stringify(getCodeEvalUserVisibleError(error))).not.toContain(
      "s3cr3t",
    );
  });

  it("does not follow redirects, so the target never receives data", async () => {
    const target = await serve(okScores);
    const origin = await serve((_req, res) => {
      res.writeHead(307, { location: target.url });
      res.end();
    });
    const error = await failure(
      sendHttpEvalRequest({ endpoint: endpoint(origin.url), body }),
    );
    expect(error.code).toBe("HTTP_URL_BLOCKED");
    expect(error.retryable).toBe(false);
    expect(target.hits).toHaveLength(0);
  });

  it.each([
    [
      "an undecryptable secret header",
      { storedHeaders: { "x-api-key": { secret: true, value: "plain" } } },
    ],
    ["malformed stored headers", { storedHeaders: { "x-api-key": "plain" } }],
    ["an undecryptable signing secret", { encryptedSecretKey: "garbage" }],
  ])("fails closed on %s without sending", async (_label, extra) => {
    const { hits, url } = await serve(okScores);
    const error = await failure(
      sendHttpEvalRequest({ endpoint: endpoint(url, extra), body }),
    );
    expect(error.code).toBe("HTTP_INVALID_CONFIG");
    expect(hits).toHaveLength(0);
  });

  it("blocks private addresses before sending anything", async () => {
    const error = await failure(
      sendHttpEvalRequest({
        endpoint: endpoint("http://169.254.169.254/?token=abc"),
        body,
        timeoutMs: 300,
      }),
    );
    expect(error.code).toBe("HTTP_URL_BLOCKED");
    expect(error.message).not.toContain("token");
  });
});

describe("validateHttpEvalUrl", () => {
  it("only allows ports 80 and 443 by default, even for allowlisted hosts", async () => {
    mutableEnv.LANGFUSE_HTTP_EVAL_ALLOWED_PORTS = ["80", "443"];
    await expect(
      validateHttpEvalUrl("http://127.0.0.1/s"),
    ).resolves.toBeUndefined();
    await expect(
      validateHttpEvalUrl("http://127.0.0.1:8123/s"),
    ).rejects.toThrow("Only ports 80 and 443 are allowed");
  });
});

describe("redactHttpEvalUrl", () => {
  it("drops credentials, query string and fragment", () => {
    expect(
      redactHttpEvalUrl("https://user:pw@evals.example.com/score?api_key=s#x"),
    ).toBe("https://evals.example.com/score");
  });
});
