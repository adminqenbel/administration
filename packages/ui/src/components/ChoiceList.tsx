import type { ReactNode } from "react";

export interface Choice {
  value: string;
  label: string;
  description?: string;
}

export interface ChoiceListProps {
  legend: string;
  name: string;
  choices: ReadonlyArray<Choice>;
  value: string | null;
  onChange: (value: string) => void;
  error?: string;
  children?: ReactNode;
}

/** One choice from a short list, as plain rows separated by hairlines. Native radios, so keyboard and screen readers work. */
export function ChoiceList({ legend, name, choices, value, onChange, error }: ChoiceListProps) {
  return (
    <fieldset className="qb-choices">
      <legend className="qb-choices__legend">{legend}</legend>
      {choices.map((c) => (
        <label key={c.value} className="qb-choice">
          <input type="radio" className="qb-choice__input" name={name} value={c.value} checked={value === c.value} onChange={() => onChange(c.value)} />
          <span className="qb-choice__text">
            <span className="qb-choice__label">{c.label}</span>
            {c.description ? <span className="qb-choice__desc">{c.description}</span> : null}
          </span>
        </label>
      ))}
      {error ? (
        <p className="qb-field__error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
