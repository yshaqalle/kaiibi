import { useEffect, useRef } from 'react';
import { TextInput, type TextInputProps } from 'react-native';

import { fieldSinkScan, initialFieldSinkState, stepFieldSink } from '@/lib/barcode-wedge';

/**
 * A text field a hardware scanner can type into without the code becoming its
 * value.
 *
 * Neither wedge catches this case. Both of them stand aside for a field the
 * user has focused -- the document listener ignores keydown once an INPUT has
 * it (use-barcode-wedge.ts:142) -- because the field owns the keyboard. That is
 * right, and it leaves the field receiving the scan as ordinary typing.
 *
 * In a search box that is merely untidy. In a quantity or unit-cost box it is
 * silent and wrong: every character of a barcode is a digit, so a scan while
 * the cursor sits in a Received box records a delivery of 8,809,611,860,018
 * units and looks exactly like a number somebody typed.
 *
 * So the field watches how fast its characters arrive (`stepFieldSink`), and on
 * the scanner's trailing Enter it puts back what it was showing before the
 * burst and hands the code to `onScan` instead. A person typing 24 and pressing
 * Enter is not a burst, gets no code, and keeps their 24.
 *
 * `onScan` is null wherever scanning is not offered -- on native inside a sheet,
 * where the Android key capture cannot see a Dialog's window at all -- and then
 * this is a plain `TextInput` with nothing added: no submit handler, no burst,
 * no behaviour to go wrong.
 */
export function ScanSafeField({
  value,
  onChangeText,
  onScan,
  ...rest
}: Omit<TextInputProps, 'value' | 'onChangeText' | 'onSubmitEditing'> & {
  value: string;
  onChangeText: (next: string) => void;
  /** Null disables every scan path here, leaving an ordinary text field. */
  onScan: ((code: string) => void) | null;
}) {
  const sinkRef = useRef(initialFieldSinkState(value));
  // What the field last showed, which is NOT always the `value` prop: at three
  // milliseconds a character a scan can outrun a commit, and measuring against
  // a prop one render behind makes the same characters look appended twice.
  // Written on the way out, so anything it does not match came from the screen.
  const shownRef = useRef(value);

  useEffect(() => {
    if (value === shownRef.current) return;
    // The screen set this field itself -- a camera scan, a reset, a row
    // re-pointed at another store. None of those are typing, so no burst and no
    // restore point survives them.
    shownRef.current = value;
    sinkRef.current = initialFieldSinkState(value);
  }, [value]);

  const handleChangeText = (next: string) => {
    if (onScan) sinkRef.current = stepFieldSink(sinkRef.current, shownRef.current, next, Date.now());
    shownRef.current = next;
    onChangeText(next);
  };

  const handleSubmit = () => {
    if (!onScan) return;
    const scan = fieldSinkScan(sinkRef.current, Date.now());
    // A burst ends at its terminator either way, so a rejected one cannot leak
    // into the next.
    sinkRef.current = initialFieldSinkState(shownRef.current);
    // Null is a person pressing Enter in a field they typed into. Leave it
    // completely alone -- including not clearing it, which is what would lose
    // the quantity somebody had just finished typing.
    if (!scan) return;
    shownRef.current = scan.restore;
    sinkRef.current = initialFieldSinkState(scan.restore);
    onChangeText(scan.restore);
    onScan(scan.code);
  };

  return (
    <TextInput
      {...rest}
      value={value}
      onChangeText={handleChangeText}
      {...(onScan
        ? {
            onSubmitEditing: handleSubmit,
            // A scanner fires this on its trailing Enter; keeping focus means
            // the next scan lands here too rather than nowhere -- which is
            // exactly why the handler has to put the field back rather than let
            // the next scan extend what this one left.
            blurOnSubmit: false,
          }
        : null)}
    />
  );
}
