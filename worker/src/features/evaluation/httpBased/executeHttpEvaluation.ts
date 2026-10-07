import { type JobConfiguration, type JobExecution } from "@prisma/client";
import {
  type EvalExecutionContext,
  type EvalTemplateHttp,
} from "@langfuse/shared";
import {
  CodeEvalExecutionError,
  instrumentAsync,
  logger,
  runHttpEvaluationDispatch,
  writeInternalTraceViaOtelIngestion,
  type ExtractedVariable,
} from "@langfuse/shared/src/server";
import { createW3CTraceId } from "../../utils";
import { type EvalExecutionResult } from "../evalCompletion";

export async function executeHttpEvaluation(params: {
  projectId: string;
  organizationId: string;
  evaluatorId?: string;
  job: JobExecution;
  config: JobConfiguration;
  template: EvalTemplateHttp;
  extractedVariables: ExtractedVariable[];
  hasExperimentContext?: boolean;
  executionMetadata: Record<string, string>;
  evaluationContext: EvalExecutionContext;
}): Promise<EvalExecutionResult> {
  return instrumentAsync({ name: "eval.execute-http-eval" }, async (span) => {
    const jobExecutionId = params.job.id;
    const executionTraceId = createW3CTraceId(jobExecutionId);
    span.setAttribute("langfuse.project.id", params.projectId);
    span.setAttribute("eval.job_execution.id", jobExecutionId);
    span.setAttribute("eval.job_configuration.id", params.config.id);
    span.setAttribute("eval.template.id", params.template.id);
    span.setAttribute("eval.template.version", params.template.version);

    logger.debug(
      `Executing HTTP evaluation for job ${jobExecutionId} in project ${params.projectId}`,
    );

    const outcome = await runHttpEvaluationDispatch({
      projectId: params.projectId,
      executionTraceId,
      jobExecutionId,
      evaluator: {
        id: params.evaluatorId ?? params.template.id,
        name: params.template.name,
        version: params.template.version,
      },
      target: {
        traceId: params.job.jobInputTraceId,
        observationId: params.job.jobInputObservationId,
      },
      endpoint: {
        url: params.template.httpUrl,
        storedHeaders: params.template.httpRequestHeaders,
        encryptedSecretKey: params.template.httpSecretKey,
      },
      extractedVariables: params.extractedVariables,
      hasExperimentContext: params.hasExperimentContext ?? false,
      traceName: `Execute evaluator: ${params.template.name}`,
      metadata: params.executionMetadata,
      evaluationContext: params.evaluationContext,
      writeTrace: (trace) => writeInternalTraceViaOtelIngestion(trace),
    });

    if (!outcome.success) {
      throw new CodeEvalExecutionError(outcome.error);
    }
    span.setAttribute("eval.score.count", outcome.scores.length);

    return {
      scores: outcome.scores,
      executionTraceId,
      metadata: params.executionMetadata,
      evaluationContext: params.evaluationContext,
    };
  });
}
