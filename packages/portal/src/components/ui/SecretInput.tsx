import { useState, type InputHTMLAttributes } from "react";
import { Input } from "./Input";
import { EyeIcon, EyeOffIcon } from "./Icons";

export interface SecretInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "autoComplete"> {
  value: string;
}

/**
 * A masked text field that browsers and password managers leave alone.
 *
 * Deliberately NOT `type="password"`: that is the signal Chrome, Safari,
 * Firefox and every password-manager extension key on to offer autofill,
 * "generate a password", and the save-this-password prompt on submit — and
 * Chrome ignores `autocomplete="off"` on such a field. A vault value or a
 * one-time secret must not end up in the browser's credential store, so the
 * field is a plain text input masked with CSS (`.ui-input-masked`), with
 * autocomplete off and the vendor opt-out attributes the common managers
 * honour (1Password, LastPass, Bitwarden, Dashlane).
 *
 * `name` is intentionally absent, and the id is not credential-shaped, so
 * heuristics on field names find nothing either.
 */
export function SecretInput({ className, ...rest }: SecretInputProps) {
  const [show, setShow] = useState(false);
  const classes = ["ui-input-has-affix", show ? "" : "ui-input-masked", className].filter(Boolean).join(" ");
  return (
    <span className="ui-input-affix">
      <Input
        type="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        data-bwignore=""
        data-form-type="other"
        className={classes}
        {...rest}
      />
      <button
        type="button"
        className="ui-input-affix-button"
        onClick={() => setShow((v) => !v)}
        aria-pressed={show}
        aria-label={show ? "Hide value" : "Show value while typing"}
        title={show ? "Hide value" : "Show value while typing"}
      >
        {show ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </span>
  );
}
