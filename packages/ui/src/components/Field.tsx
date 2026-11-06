import { useId } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cx } from "../cx.ts";

export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  id?: string;
  className?: string;
  /** Render the control with the props that wire the label, hint and error to it. */
  children: (control: FieldControlProps) => ReactNode;
}

export function Field({ label, hint, error, required, id, className, children }: FieldProps) {
  const auto = useId();
  const controlId = id ?? auto;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const describedBy = [hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ");
  const control: FieldControlProps = { id: controlId };
  if (describedBy) control["aria-describedby"] = describedBy;
  if (error) control["aria-invalid"] = true;
  if (required) control["aria-required"] = true;
  return (
    <div className={cx("qb-field", className)}>
      <label className="qb-field__label" htmlFor={controlId}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {hint ? (
        <p className="qb-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {children(control)}
      {error ? (
        <p className="qb-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface FieldExtras {
  label: string;
  hint?: string;
  error?: string;
  fieldClassName?: string;
}

export type InputProps = Omit<ComponentPropsWithoutRef<"input">, "id"> & FieldExtras & { id?: string };

export function Input({ label, hint, error, fieldClassName, id, required, className, ...rest }: InputProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required} id={id} className={fieldClassName}>
      {(c) => <input className={cx("qb-control", className)} required={required} {...c} {...rest} />}
    </Field>
  );
}

export type TextareaProps = Omit<ComponentPropsWithoutRef<"textarea">, "id"> & FieldExtras & { id?: string };

export function Textarea({ label, hint, error, fieldClassName, id, required, className, ...rest }: TextareaProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required} id={id} className={fieldClassName}>
      {(c) => <textarea className={cx("qb-control", className)} required={required} {...c} {...rest} />}
    </Field>
  );
}

export type SelectProps = Omit<ComponentPropsWithoutRef<"select">, "id"> & FieldExtras & { id?: string };

export function Select({ label, hint, error, fieldClassName, id, required, className, children, ...rest }: SelectProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required} id={id} className={fieldClassName}>
      {(c) => (
        <div className="qb-select">
          <select className={cx("qb-control", className)} required={required} {...c} {...rest}>
            {children}
          </select>
        </div>
      )}
    </Field>
  );
}
