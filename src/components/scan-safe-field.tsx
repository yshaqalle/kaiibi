import { useEffect, useRef, useState } from 'react';
import { TextInput, type TextInputProps } from 'react-native';

import { DEFAULT_WEDGE_CONFIG, fieldSinkScan, initialFieldSinkState, stepFieldSink } from '@/lib/barcode-wedge';

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
 * ## The screen is told LATE, on purpose
 *
 * While `onScan` is set, a change is not passed to `onChangeText` the moment it
 * happens. It is shown here immediately -- the box always reads exactly what
 * was typed into it, with the caret where it was -- and handed to the screen
 * one inter-character gap later (`maxInterKeyMs`, 50ms: the span that separates
 * a scanner from a typist), or at once on blur or on a rejected Enter.
 *
 * That wait is what makes this component safe in front of a parent that
 * REWRITES what it is given, which is the ordinary case rather than an exotic
 * one:
 *
 *  - `QuantityField` renders `quantity === 0 ? '' : String(quantity)`. A
 *    scanner's first character `0` -- every UPC-A read as EAN-13 begins with
 *    one -- would come back as `''`, which no longer matches what the field is
 *    showing, and the burst and its restore point would be thrown away as "the
 *    screen set this itself".
 *  - Worse, the Move sheet DROPS a line whose quantity reaches 0
 *    (stock-transfer-modal.tsx's `setQuantity`), so that same leading zero
 *    unmounted the very field the rest of the code was being typed into: the
 *    typed quantity was gone and the row was rebuilt at 1.
 *
 * Withholding closes both, because during a burst the screen is never told
 * anything to rewrite or to react to. It also means a scan can no longer leave
 * a barcode sitting in the screen's own state for a render, which is what let
 * `addByCode` read one.
 *
 * A burst that has reached code length is treated as a machine's from then on:
 * its terminator can trail the last digit by the better part of a second (see
 * `maxTerminatorGapMs`), so it is waited for, and if it never comes the box is
 * put back to what it held before. A scanner configured to send no suffix at
 * all is not supported here -- but the failure is a scan that does nothing,
 * never a barcode recorded as a quantity.
 *
 * `onScan` is null wherever scanning is not offered -- on native inside a sheet,
 * where the Android key capture cannot see a Dialog's window at all -- and then
 * this is a plain `TextInput` with nothing added: no submit handler, no burst,
 * no delay, no behaviour to go wrong.
 */
export function ScanSafeField({
  value,
  onChangeText,
  onScan,
  onBlur,
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
  // The prop as a handler running later sees it -- a blur, a timer -- rather
  // than as the render that armed them saw it. Written after the commit, which
  // is soon enough: nothing here reads it during a render.
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // Text this field is showing that the screen has NOT been told about yet.
  // Null means the two agree and the prop is what shows. Held in state so the
  // box repaints, and in a ref so the handlers below can read it in the same
  // tick they set it.
  const [held, setHeld] = useState<string | null>(null);
  const heldRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hold = (text: string | null) => {
    heldRef.current = text;
    setHeld(text);
  };

  const stopTimer = () => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  // Nothing is coming after this: give the screen what the box is showing.
  const handOver = () => {
    stopTimer();
    const text = heldRef.current;
    if (text === null) return;
    hold(null);
    onChangeText(text);
  };

  // A machine's burst whose terminator never arrived. Nothing of it ever
  // reached the screen, so putting the box back is only dropping what is held.
  const abandon = () => {
    stopTimer();
    hold(null);
    shownRef.current = valueRef.current;
    sinkRef.current = initialFieldSinkState(valueRef.current);
  };

  useEffect(() => stopTimer, []);

  useEffect(() => {
    // While this field is showing text of its own, a prop is not news: it is
    // either one render behind or the screen's rewrite of something we have
    // not sent yet. Re-checked when `held` clears, which is why it is a
    // dependency.
    if (held !== null) return;
    if (value === shownRef.current) return;
    // The screen set this field itself -- a camera scan, a reset, a row
    // re-pointed at another store, or its own normalising of what we just
    // handed over. None of those are typing, so no burst and no restore point
    // survives them.
    shownRef.current = value;
    sinkRef.current = initialFieldSinkState(value);
  }, [value, held]);

  const handleChangeText = (next: string) => {
    if (!onScan) {
      onChangeText(next);
      return;
    }
    const at = Date.now();
    const sink = stepFieldSink(sinkRef.current, shownRef.current, next, at);
    sinkRef.current = sink;
    shownRef.current = next;
    hold(next);
    stopTimer();
    // Past `minLength` at scanner speed this is a code, and the only thing that
    // may end it is its terminator -- which is allowed to be a long way behind.
    // Below that it is still anybody's, so it goes to the screen as soon as the
    // gap that would have made it a scan has passed.
    const isCode = sink.burst.burst.length >= DEFAULT_WEDGE_CONFIG.minLength;
    timerRef.current = setTimeout(
      isCode ? abandon : handOver,
      isCode ? DEFAULT_WEDGE_CONFIG.maxTerminatorGapMs : DEFAULT_WEDGE_CONFIG.maxInterKeyMs
    );
  };

  const handleSubmit = () => {
    if (!onScan) return;
    stopTimer();
    const scan = fieldSinkScan(sinkRef.current, Date.now());
    if (!scan) {
      // A person pressing Enter in a field they typed into. Their text is real
      // and unsent: hand it over, and otherwise leave the field completely
      // alone -- including not clearing it, which is what would lose the
      // quantity somebody had just finished typing.
      handOver();
      // A burst ends at its terminator either way, so a rejected one cannot
      // leak into the next.
      sinkRef.current = initialFieldSinkState(shownRef.current);
      return;
    }
    hold(null);
    shownRef.current = scan.restore;
    sinkRef.current = initialFieldSinkState(scan.restore);
    // Almost always a no-op, because nothing of the burst was ever sent -- kept
    // so that "the box ends up holding what it held before" stays true even if
    // some of it was.
    if (scan.restore !== valueRef.current) onChangeText(scan.restore);
    onScan(scan.code);
  };

  const handleBlur: TextInputProps['onBlur'] = (event) => {
    // Focus is leaving, so no terminator is coming. A code-length burst is a
    // machine's and must not become the value; anything shorter is a person's
    // and must not be lost.
    if (sinkRef.current.burst.burst.length >= DEFAULT_WEDGE_CONFIG.minLength) abandon();
    else handOver();
    onBlur?.(event);
  };

  return (
    <TextInput
      {...rest}
      value={held ?? value}
      onChangeText={handleChangeText}
      onBlur={onScan ? handleBlur : onBlur}
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
