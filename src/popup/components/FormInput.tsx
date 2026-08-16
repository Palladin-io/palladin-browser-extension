import type { InputHTMLAttributes } from "react";
import { useId } from "react";

/**
 * Labelled text input with a self-collapsing inline error below it, mirroring
 * the web panel `FormInput` + `FeedbackSlot` density.
 */
export interface FormInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  label: string;
  /** Inline validation/error text; the row is invisible (but present) when empty. */
  error?: string;
}

export function FormInput({ label, error, id, ...props }: FormInputProps): React.JSX.Element {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hasError = Boolean(error);
  return (
    <div>
      <label htmlFor={inputId} className="field-label">
        {label}
      </label>
      <input
        id={inputId}
        className={`field-input${hasError ? " field-input--error" : ""}`}
        aria-invalid={hasError || undefined}
        {...props}
      />
      {hasError ? <p className="field-feedback" role="alert">{error}</p> : null}
    </div>
  );
}
