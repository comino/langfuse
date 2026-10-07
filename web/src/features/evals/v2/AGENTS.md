# Evaluators v2

This is the new version of evaluations that uses a new data model.
The old change used:

- `eval_templates` (definition of an evaluator)
- `job_configurations` (variable mapping and which events it runs against)

The new data model is

- Evaluator
- Rule (basically the old `job_configuration`)
- Rule assignments (association table handling the n:m relationship)

FACET evaluators are internal and must be excluded from user-facing evaluator and rule queries.

HTTP evaluators call a user-configured endpoint and only run when `LANGFUSE_HTTP_EVAL_ENABLED=true`. Their encrypted header values and signing secret are hidden by the global Prisma omit in `packages/shared/src/db.ts`; only the worker delivery path opts back in. They are not exposed through the public API or legacy eval templates.

Traces captured during the eval executions in the past only captured `job_configuration_id`.
Only new runs capture `evaluator_id` and `evaluation_rule_id`.

## Testing

- Do not write tautological React client tests or tests that assert pixel positioning.
- Only add component tests when they enforce meaningful behavior.
