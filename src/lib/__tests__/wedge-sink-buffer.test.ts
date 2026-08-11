import { flushSink, initialSinkState, stepSink, type SinkState } from '@/lib/barcode-wedge';

// The sink is fed `onChangeText`, whose contract is the WHOLE contents of the
// field, not a delta. These tests describe what the field looks like from the
// outside across a series of scans -- including the case the component cannot
// control, where `clear()` does not actually empty the native view.
function scanInto(state: SinkState, fieldText: string) {
  return stepSink(state, fieldText, 0);
}

describe('stepSink', () => {
  it('emits a code that arrives with its terminator in one event', () => {
    const step = scanInto(initialSinkState(), '8809447255972\n');
    expect(step.emit).toBe('8809447255972');
  });

  it('emits nothing until the terminator arrives', () => {
    const step = scanInto(initialSinkState(), '8809447255972');
    expect(step.emit).toBeNull();
  });

  it('assembles a code delivered in several events', () => {
    let state = initialSinkState();
    let step = scanInto(state, '88094');
    state = step.state;
    expect(step.emit).toBeNull();

    step = scanInto(state, '8809447255972\n');
    expect(step.emit).toBe('8809447255972');
  });

  // The regression. A scanned code stays in the native field: `clear()` goes
  // through `setNativeProps`, which the New Architecture does not reliably
  // apply, so the NEXT scan arrives with the previous code still in front of
  // it. Before this fix that emitted `88094472559723846447255972`, which
  // matches no product and grew with every further scan.
  it('emits only the new code when the field was never emptied', () => {
    let state = initialSinkState();
    let step = scanInto(state, '8809447255972\n');
    state = step.state;
    expect(step.emit).toBe('8809447255972');

    step = scanInto(state, '8809447255972\n3846447255972\n');
    expect(step.emit).toBe('3846447255972');
  });

  it('keeps emitting one code at a time however long the field grows', () => {
    let state = initialSinkState();
    let field = '';
    const emitted: string[] = [];

    for (const code of ['8809447255972', '3846447255972', '5901234123457']) {
      field += `${code}\n`;
      const step = stepSink(state, field, 0);
      state = step.state;
      if (step.emit) emitted.push(step.emit);
    }

    expect(emitted).toEqual(['8809447255972', '3846447255972', '5901234123457']);
  });

  it('treats the field as fresh when clear() did work', () => {
    let state = initialSinkState();
    state = scanInto(state, '8809447255972\n').state;

    // The field really was emptied, so the next scan is the whole text.
    const step = scanInto(state, '3846447255972\n');
    expect(step.emit).toBe('3846447255972');
  });

  it('accepts a carriage return or a tab as the terminator', () => {
    expect(scanInto(initialSinkState(), '8809447255972\r').emit).toBe('8809447255972');
    expect(scanInto(initialSinkState(), '8809447255972\t').emit).toBe('8809447255972');
  });

  it('drops a burst that never terminated rather than prefixing the next scan', () => {
    let state = initialSinkState();
    // A misread: characters arrive, no terminator ever does.
    state = scanInto(state, '3846').state;

    // Long enough later that this is plainly a separate scan.
    const step = stepSink(state, '38468809447255972\n', 5_000);
    expect(step.emit).toBe('8809447255972');
  });

  it('does not drop a burst still being delivered', () => {
    let state = initialSinkState();
    state = stepSink(state, '88094', 0).state;

    const step = stepSink(state, '8809447255972\n', 40);
    expect(step.emit).toBe('8809447255972');
  });
});

describe('flushSink', () => {
  // `onSubmitEditing` -- the scanner pressed Enter and the field reported it as
  // a submit rather than as text.
  it('emits what has not been emitted yet', () => {
    const step = flushSink(initialSinkState(), '8809447255972');
    expect(step.emit).toBe('8809447255972');
  });

  it('emits only the new code when the field kept the last one', () => {
    let state = initialSinkState();
    state = flushSink(state, '8809447255972').state;

    const step = flushSink(state, '88094472559723846447255972');
    expect(step.emit).toBe('3846447255972');
  });

  it('emits nothing when there is nothing new', () => {
    let state = initialSinkState();
    state = flushSink(state, '8809447255972').state;

    expect(flushSink(state, '8809447255972').emit).toBeNull();
  });

  it('ignores a stray terminator on an empty field', () => {
    expect(flushSink(initialSinkState(), '').emit).toBeNull();
  });
});
