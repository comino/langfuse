import { EvalTemplateTypeEnum } from "@langfuse/shared";

type DisplayHeaders = Record<string, { secret: boolean; value: string }>;

function isDisplayHeaders(value: unknown): value is DisplayHeaders {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every(
      (header) =>
        typeof header?.secret === "boolean" &&
        typeof header?.value === "string",
    )
  );
}

/** The editable HTTP definition from a stored version; secrets stay empty. */
export function toHttpSetupDefinition(version: {
  httpUrl?: string | null;
  httpDisplayHeaders?: unknown;
}) {
  const headers = isDisplayHeaders(version.httpDisplayHeaders)
    ? version.httpDisplayHeaders
    : {};
  return {
    type: EvalTemplateTypeEnum.HTTP,
    url: version.httpUrl ?? "",
    headers: Object.entries(headers).map(([name, { secret, value }]) => ({
      name,
      secret,
      value: secret ? "" : value,
    })),
  };
}
