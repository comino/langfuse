import { EvalTemplateTypeEnum, type EvalTemplateType } from "@langfuse/shared";

/**
 * Code and HTTP evaluators receive the fixed observation payload, need no
 * variable mapping and run without an LLM, so they have no model cost.
 */
export function isFixedPayloadEvaluator(type: EvalTemplateType | undefined) {
  return (
    type === EvalTemplateTypeEnum.CODE || type === EvalTemplateTypeEnum.HTTP
  );
}
