import { Lock, LockOpen, Plus, X } from "lucide-react";

import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import type { HttpHeaderDraft } from "@/src/features/evals/v2/store/evaluatorSetupStore/evaluatorSetupStore";

/** Endpoint URL and request headers of an HTTP evaluator. */
export function HttpEndpointEditor({
  url,
  headers,
  storedSecretNames = [],
  onUrlChange,
  onHeaderChange,
  onAddHeader,
  onRemoveHeader,
  disabled = false,
}: {
  url: string;
  headers: HttpHeaderDraft[];
  /** Secret headers that already have a stored value. */
  storedSecretNames?: string[];
  onUrlChange: (url: string) => void;
  onHeaderChange: (id: string, patch: Partial<HttpHeaderDraft>) => void;
  onAddHeader: () => void;
  onRemoveHeader: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <Label htmlFor="http-evaluator-url">Endpoint URL</Label>
        <Input
          id="http-evaluator-url"
          placeholder="https://evals.example.com/score"
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          disabled={disabled}
        />
        <p className="text-muted-foreground text-xs">
          Langfuse sends each observation as a signed POST request and stores
          the scores the endpoint returns. Do not put credentials in the URL;
          use a secret header instead.
        </p>
      </section>
      <section className="flex flex-col gap-2">
        <Label>Headers</Label>
        {headers.map((header) => {
          const hasStoredSecret =
            header.secret && storedSecretNames.includes(header.name);
          return (
            <div
              key={header.id}
              className="grid grid-cols-[1fr_1fr_auto_auto] gap-2"
            >
              <Input
                aria-label="Header name"
                placeholder="Name"
                value={header.name}
                onChange={(event) =>
                  onHeaderChange(header.id, { name: event.target.value })
                }
                disabled={disabled}
              />
              <Input
                aria-label="Header value"
                placeholder={
                  hasStoredSecret ? "Saved (leave empty to keep)" : "Value"
                }
                type={header.secret ? "password" : "text"}
                value={header.value}
                onChange={(event) =>
                  onHeaderChange(header.id, { value: event.target.value })
                }
                disabled={disabled}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title={
                  header.secret ? "Make header public" : "Make header secret"
                }
                onClick={() =>
                  onHeaderChange(header.id, {
                    secret: !header.secret,
                    value: "",
                  })
                }
                disabled={disabled}
              >
                {header.secret ? (
                  <Lock className="icon-base" />
                ) : (
                  <LockOpen className="icon-base text-muted-foreground" />
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title="Remove header"
                onClick={() => onRemoveHeader(header.id)}
                disabled={disabled}
              >
                <X className="icon-base" />
              </Button>
            </div>
          );
        })}
        {!disabled && (
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={onAddHeader}
          >
            <Plus className="icon-base mr-1" />
            Add header
          </Button>
        )}
      </section>
    </div>
  );
}
