import { useEffect, useRef, useState } from 'react';
import type { ReportReason } from '@meet-strangers/shared';

const REASONS: Array<{ value: ReportReason; label: string }> = [
  { value: 'nudity', label: 'Nudity or sexual content' },
  { value: 'harassment', label: 'Harassment, hate or threats' },
  { value: 'underage', label: 'Appears to be under 18' },
  { value: 'spam', label: 'Spam or advertising' },
  { value: 'other', label: 'Something else' },
];

interface ReportDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (reason: ReportReason) => void;
}

/** Native <dialog>: focus trapping, Esc to close and inert background come for free. */
export function ReportDialog({ open, onClose, onSubmit }: ReportDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState<ReportReason | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setReason(null);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="report-title">
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason) onSubmit(reason);
        }}
      >
        <h2 id="report-title">Report this stranger</h2>
        <p className="muted">
          The chat will end and you'll be connected to someone new. Reports are anonymous.
        </p>
        <fieldset className="report-reasons">
          <legend className="visually-hidden">Reason</legend>
          {REASONS.map((option) => (
            <label key={option.value} className="radio">
              <input
                type="radio"
                name="reason"
                value={option.value}
                checked={reason === option.value}
                onChange={() => setReason(option.value)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <div className="dialog__actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button--danger" disabled={!reason}>
            Report and skip
          </button>
        </div>
      </form>
    </dialog>
  );
}
