import type { InputHTMLAttributes } from "react";
import { useId } from "react";

/**
 * Labelled text input with an inline error slot below it — the popup's local
 * mirror of the web panel `FormInput` + `FieldFeedback`. The error row keeps a
 * reserved height so the form doesn't jump when a message appears, and carries
 * `role="alert"` so it's announced.
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
      <p
        className={`field-feedback${hasError ? " field-feedback--visible" : ""}`}
        role={hasError ? "alert" : undefined}
      >
        {error}
      </p>
    </div>
  );
}
