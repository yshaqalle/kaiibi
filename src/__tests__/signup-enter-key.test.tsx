// Enter walks the signup form.
//
// Signup is a three-step wizard behind ONE button that either continues or
// creates the shop, and until now the return key did neither -- three screens
// of fields and a reach for the mouse between each. These tests hold the two
// rules that fix that, and the one that keeps it safe:
//
//   1. A field in the middle of a step hands focus on and keeps the keyboard
//      up. That is `submitBehavior="submit"`; the default for a single-line
//      field is to drop the keyboard, and a keyboard that closes four times on
//      the way down step 1 is worse than one that never opened.
//   2. The LAST field of a step presses the button under it.
//   3. That press obeys the button's own rules. The button is disabled while a
//      step is incomplete or a signup is in flight; the return key is never
//      disabled, so the guard has to live in `next()` -- without it, Enter
//      advances a half-filled step, and two quick presses fire two signups.
//
// Lives here rather than beside the screen for the reason orders-screen.test.tsx
// gives: expo-router builds its route table from `require.context(src/app)` and
// nothing on that scan skips `.test.tsx`, so a test file under src/app would
// become a real route in the shipped bundle.

import { TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}));

// `t` returns the key it was given, so the assertions below can name the step
// headings without depending on the copy in either language.
jest.mock('@/hooks/use-locale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ refreshShop: jest.fn(async () => {}) }),
}));

jest.mock('@/lib/auth', () => ({ signUpAdmin: jest.fn(async () => {}) }));
jest.mock('@/lib/shops', () => ({ createShop: jest.fn(async () => {}) }));

import { signUpAdmin } from '@/lib/auth';
import { createShop } from '@/lib/shops';
import SignUpScreen from '@/app/(public)/(tabs)/signup';

function fields(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAllByType(TextInput);
}

function type(field: ReactTestInstance, text: string) {
  act(() => {
    field.props.onChangeText(text);
  });
}

function pressEnter(field: ReactTestInstance) {
  act(() => {
    field.props.onSubmitEditing?.();
  });
}

// Step 1 asks for four things and refuses to advance without all of them
// (`password.length >= 6` included).
function completeStepOne(tree: ReactTestRenderer) {
  const [name, contact, email, password] = fields(tree);
  type(name, 'Yusef');
  type(contact, '063 4567890');
  type(email, 'yusef@example.com');
  type(password, 'hunter2!');
}

function headings(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => typeof node.props?.children === 'string')
    .map((node) => node.props.children as string);
}

let tree: ReactTestRenderer;

beforeEach(() => {
  jest.clearAllMocks();
  act(() => {
    tree = create(<SignUpScreen />);
  });
});

afterEach(() => {
  act(() => tree.unmount());
});

describe('the field chain', () => {
  it('keeps the keyboard up on every field that hands focus on', () => {
    const [name, contact, email, password] = fields(tree);

    for (const field of [name, contact, email]) {
      expect(field.props.submitBehavior).toBe('submit');
      expect(field.props.returnKeyType).toBe('next');
      expect(typeof field.props.onSubmitEditing).toBe('function');
    }

    // The last field of the step is the exception in both respects: it submits,
    // so the keyboard is allowed to fall as the screen changes under it.
    expect(password.props.submitBehavior).toBe('blurAndSubmit');
    expect(password.props.returnKeyType).toBe('go');
  });

  it('gives every field of every step something for Enter to do', () => {
    completeStepOne(tree);
    pressEnter(fields(tree)[3]);
    for (const field of fields(tree)) expect(typeof field.props.onSubmitEditing).toBe('function');

    type(fields(tree)[0], 'Yusef Shop');
    pressEnter(fields(tree)[0]);
    for (const field of fields(tree)) expect(typeof field.props.onSubmitEditing).toBe('function');
  });
});

describe('Enter on the last field of a step', () => {
  it('advances a complete step', () => {
    expect(headings(tree)).toContain('signup.step1');

    completeStepOne(tree);
    pressEnter(fields(tree)[3]);

    expect(headings(tree)).toContain('signup.step2');
    expect(headings(tree)).not.toContain('signup.step1');
  });

  it('refuses to advance an incomplete one, exactly as the disabled button does', () => {
    const [name, , , password] = fields(tree);
    type(name, 'Yusef');
    // Nothing else filled in -- `valid` is false and the button is greyed out.
    pressEnter(password);

    expect(headings(tree)).toContain('signup.step1');
    expect(headings(tree)).not.toContain('signup.step2');
  });

  it('refuses on a password under six characters', () => {
    const [name, contact, email, password] = fields(tree);
    type(name, 'Yusef');
    type(contact, '063 4567890');
    type(email, 'yusef@example.com');
    type(password, 'short');
    pressEnter(password);

    expect(headings(tree)).toContain('signup.step1');
  });
});

describe('Enter on the last field of the last step', () => {
  async function reachStepThree() {
    completeStepOne(tree);
    pressEnter(fields(tree)[3]);

    type(fields(tree)[0], 'Yusef Shop');
    pressEnter(fields(tree)[0]);

    expect(headings(tree)).toContain('signup.step3');
  }

  it('creates the account and the shop', async () => {
    await reachStepThree();

    // Step 3 is city and neighbourhood; the city is pre-filled with Hargeisa,
    // so the last field is the only one that has to be touched.
    const [, area] = fields(tree);
    type(area, 'Jigjiga Yar');
    await act(async () => {
      await fields(tree)[1].props.onSubmitEditing();
    });

    expect(signUpAdmin).toHaveBeenCalledTimes(1);
    expect(signUpAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'yusef@example.com', fullName: 'Yusef' }),
    );
    expect(createShop).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Yusef Shop', city: 'Hargeisa', neighborhood: 'Jigjiga Yar' }),
    );
  });

  it('does not sign the same person up twice when Enter is pressed twice', async () => {
    await reachStepThree();

    // Both presses land before the first one settles -- which is exactly what a
    // second impatient press on a slow connection looks like. The button is
    // disabled for that window; the return key is not, so `next()` has to
    // refuse the second one itself.
    await act(async () => {
      const area = fields(tree)[1];
      area.props.onSubmitEditing();
      area.props.onSubmitEditing();
    });

    expect(signUpAdmin).toHaveBeenCalledTimes(1);
  });
});
