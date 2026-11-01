import {
  REFERENCE_GOOD_SECONDS,
  REFERENCE_MAX_SECONDS,
  REFERENCE_MIN_SECONDS,
} from "../lib/tts";

/** How much speech is chosen for a reference, and whether it is enough. */
export function ReferenceAmount({ count, noun, total }: { count: number; noun: string; total: number }) {
  return (
    <p
      className={
        total < REFERENCE_MIN_SECONDS ? "error" : total < REFERENCE_GOOD_SECONDS ? "hint" : "status"
      }
    >
      {count} {noun}
      {count === 1 ? "" : "s"}, {total.toFixed(1)} s
      {total > REFERENCE_MAX_SECONDS && ` — the first ${REFERENCE_MAX_SECONDS} s are used`}.{" "}
      {total < REFERENCE_MIN_SECONDS
        ? `Turbo needs more than ${REFERENCE_MIN_SECONDS} s.`
        : total < REFERENCE_GOOD_SECONDS
          ? `Enough to work; ${REFERENCE_GOOD_SECONDS}–20 s clones better.`
          : "A good amount."}
    </p>
  );
}

/** What to keep the built voice as, if anything: a name, or null for nothing. */
export interface TemplateChoice {
  save: boolean;
  name: string;
}

/** The template name to save under, or null when none is to be saved. */
export function templateName(choice: TemplateChoice): string | null {
  const name = choice.name.trim();
  return choice.save && name ? name : null;
}

/** "Also keep this voice as a template", with its name. */
export function TemplateOption({
  choice,
  disabled,
  onChange,
}: {
  choice: TemplateChoice;
  disabled: boolean;
  onChange: (choice: TemplateChoice) => void;
}) {
  return (
    <div className="reference-template">
      <label>
        <input
          type="checkbox"
          checked={choice.save}
          disabled={disabled}
          onChange={(e) => onChange({ ...choice, save: e.target.checked })}
        />
        Save as a voice template
      </label>
      <input
        type="text"
        value={choice.name}
        placeholder="Template name"
        disabled={disabled || !choice.save}
        onChange={(e) => onChange({ ...choice, name: e.target.value })}
        title="Templates can be given to a speaker in any project"
      />
    </div>
  );
}
