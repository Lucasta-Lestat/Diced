import { useEffect, useRef, useState } from 'react';
import { numberToInput, parseDecimal } from '../forms';
import { TextField } from './TextField';

export interface NumberFieldProps {
  label: string;
  value: number | null;
  /** Called on every keystroke with the parsed value (null while empty/invalid). */
  onChangeValue?: (value: number | null, text: string) => void;
  /** Called when editing ends and the value changed and is valid (null = cleared). */
  onCommit?: (value: number | null) => void;
  unit?: string;
  decimals?: number;
  min?: number;
  max?: number;
  placeholder?: string;
  helper?: string | null;
  error?: string | null;
  editable?: boolean;
  accessibilityLabel?: string;
}

/**
 * Numeric input that keeps the user's partial text ("182.") while typing and only resyncs
 * from `value` when it changes from outside and the field isn't being edited.
 */
export function NumberField({
  label,
  value,
  onChangeValue,
  onCommit,
  unit,
  decimals = 0,
  min,
  max,
  placeholder,
  helper,
  error,
  editable = true,
  accessibilityLabel,
}: NumberFieldProps) {
  const [text, setText] = useState(() => numberToInput(value, decimals));
  const [localError, setLocalError] = useState<string | null>(null);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(numberToInput(value, decimals));
  }, [value, decimals]);

  const validate = (n: number | null): string | null => {
    if (n === null) return null;
    if (min !== undefined && n < min) return `Must be at least ${min}${unit ? ` ${unit}` : ''}.`;
    if (max !== undefined && n > max) return `Must be at most ${max}${unit ? ` ${unit}` : ''}.`;
    return null;
  };

  const onChangeText = (next: string) => {
    setText(next);
    const parsed = next.trim() === '' ? null : parseDecimal(next);
    setLocalError(next.trim() !== '' && parsed === null ? 'Enter a number.' : validate(parsed));
    onChangeValue?.(parsed, next);
  };

  const onEndEditing = () => {
    focused.current = false;
    const parsed = text.trim() === '' ? null : parseDecimal(text);
    if ((text.trim() !== '' && parsed === null) || validate(parsed)) return;
    if (parsed !== value) onCommit?.(parsed);
  };

  return (
    <TextField
      label={label}
      value={text}
      onChangeText={onChangeText}
      onFocus={() => {
        focused.current = true;
      }}
      onEndEditing={onEndEditing}
      onSubmitEditing={onEndEditing}
      keyboardType={decimals > 0 ? 'decimal-pad' : 'number-pad'}
      returnKeyType="done"
      placeholder={placeholder}
      suffix={unit}
      helper={helper}
      error={error ?? localError}
      editable={editable}
      accessibilityLabel={accessibilityLabel ?? (unit ? `${label} in ${unit}` : label)}
      selectTextOnFocus
    />
  );
}
