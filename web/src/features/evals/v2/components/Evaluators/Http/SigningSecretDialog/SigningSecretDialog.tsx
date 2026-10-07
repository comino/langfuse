import { Button } from "@/src/components/ui/button";
import { CodeView } from "@/src/components/ui/CodeJsonViewer";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/dialog";

/** Shows a new HTTP evaluator's signing secret; it cannot be viewed again. */
export function SigningSecretDialog({
  secret,
  onConfirm,
}: {
  secret: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={secret !== null}
      onOpenChange={(open) => !open && onConfirm()}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Signing secret</DialogTitle>
          <DialogDescription>
            Use this secret to verify the x-langfuse-signature header in your
            endpoint. It is shown only once.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {secret ? (
            <CodeView content={secret} defaultCollapsed={false} />
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onConfirm}>I&apos;ve saved the secret</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
