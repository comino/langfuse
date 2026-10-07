import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { HttpEndpointEditor } from "@/src/features/evals/v2/components/Evaluators/Http/HttpEndpointEditor/HttpEndpointEditor";
import type { EvaluatorSetupStore } from "@/src/features/evals/v2/store/evaluatorSetupStore/evaluatorSetupStore";

export function HttpEditor({ store }: { store: EvaluatorSetupStore }) {
  const state = useStore(
    store,
    useShallow((state) => ({
      url: state.httpUrl,
      headers: state.httpHeaders,
      initialDefinition: state.initialDefinition,
      actions: state.actions,
    })),
  );
  const storedSecretNames =
    state.initialDefinition?.type === "HTTP"
      ? state.initialDefinition.headers
          .filter((header) => header.secret)
          .map((header) => header.name)
      : [];

  return (
    <HttpEndpointEditor
      url={state.url}
      headers={state.headers}
      storedSecretNames={storedSecretNames}
      onUrlChange={state.actions.setHttpUrl}
      onHeaderChange={state.actions.updateHttpHeader}
      onAddHeader={state.actions.addHttpHeader}
      onRemoveHeader={state.actions.removeHttpHeader}
    />
  );
}
