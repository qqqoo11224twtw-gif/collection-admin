import { Button } from '@saasflare-dev/ui/components/button';
import {
  DialogClose,
  DialogContent as SharedDialogContent,
} from '@saasflare-dev/ui/components/dialog';
import { XIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

/** Keep the shared dialog unchanged and translate its accessible close label. */
export function DialogContent({
  children,
  showCloseButton = true,
  ...props
}: ComponentProps<typeof SharedDialogContent>) {
  return (
    <SharedDialogContent {...props} showCloseButton={false}>
      {children}
      {showCloseButton && (
        <DialogClose asChild>
          <Button
            variant="ghost"
            className="absolute top-4 right-4"
            size="icon-sm"
          >
            <XIcon />
            <span className="sr-only">關閉</span>
          </Button>
        </DialogClose>
      )}
    </SharedDialogContent>
  );
}
