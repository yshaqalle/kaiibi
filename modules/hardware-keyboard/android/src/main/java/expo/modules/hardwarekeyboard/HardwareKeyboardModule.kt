package expo.modules.hardwarekeyboard

import android.content.Context
import android.hardware.input.InputManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.View
import android.view.ViewTreeObserver
import android.view.Window
import android.widget.EditText
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Is a physical keyboard attached to THIS device, and what is it typing? See
// the iOS twin for why this reports a keyboard and never a scanner.
//
// The second question is the one that matters at a till. A HID barcode scanner
// types its code and presses Enter, so the only way to read it is to receive
// keystrokes -- and React Native offers no global hardware-key event. The app's
// answer used to be an invisible, permanently-focused TextInput to type into,
// which worked and cost three bugs: it fought every modal for the caret, it
// swallowed everything a real keyboard typed, and on a till with "Show
// on-screen keyboard" enabled it made Android raise the soft keyboard on every
// scan, because a focused editor is an editor whatever it looks like.
//
// A key event reaches the Activity's window BEFORE any view sees it, so
// listening there needs no focus at all: nothing is focused, nothing is
// stolen, no editor exists for the IME to appear for. That is the same shape
// as the web build's `document` listener, which is why both can now share one
// state machine in JS.
// "No React tag was known" -- kept identical to the iOS twin, where an optional
// argument turned out not to be exposed to JS at all.
private const val NO_TAG = -1

class HardwareKeyboardModule : Module() {
  private val inputManager: InputManager?
    get() = appContext.reactContext?.getSystemService(Context.INPUT_SERVICE) as? InputManager

  private val listener = object : InputManager.InputDeviceListener {
    override fun onInputDeviceAdded(deviceId: Int) = emitState()
    override fun onInputDeviceRemoved(deviceId: Int) = emitState()
    override fun onInputDeviceChanged(deviceId: Int) = emitState()
  }

  // `isVirtual` is not optional here: Android's own on-screen keyboard reports
  // as an input device with SOURCE_KEYBOARD, so counting it would make every
  // phone in the world claim a hardware keyboard.
  private fun isAttached(): Boolean = InputDevice.getDeviceIds().any { id ->
    val device = InputDevice.getDevice(id) ?: return@any false
    !device.isVirtual &&
      (device.sources and InputDevice.SOURCE_KEYBOARD) == InputDevice.SOURCE_KEYBOARD &&
      device.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC
  }

  private fun emitState() {
    sendEvent("onChange", mapOf("attached" to isAttached()))
  }

  // The window callback this replaced, kept so it can be put back exactly as it
  // was. Anything else in the app that wraps the callback later would be
  // discarded by a blind restore, so it is only ever restored from here.
  private var previousCallback: Window.Callback? = null

  // WHICH window was wrapped, not merely whether one was. An Activity is
  // recreated on a dev reload and on a configuration change, and its window
  // goes with it: the wrapper installed on the old one is gone, while a flag
  // saying "already wrapped" would report the new window as covered and leave
  // scanning silently dead. Observed exactly that -- a reload, and every scan
  // afterwards fell through to the view under it and pressed whatever Android
  // had focused.
  private var wrappedWindow: Window? = null

  // Whether JS still wants keys, so a returning Activity can be re-wrapped
  // without a second subscription.
  private var capturing = false

  private val main = Handler(Looper.getMainLooper())

  // A scanner sends only printable characters and a terminator, and a person
  // pressing Shift for an uppercase SKU must not break the burst. `stepWedge`
  // in JS already ignores anything whose name is longer than one character, so
  // modifiers and arrows are reported honestly rather than filtered here --
  // one less place for the two halves to disagree about what a key is.
  private fun keyName(event: KeyEvent): String? {
    when (event.keyCode) {
      KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> return "Enter"
      KeyEvent.KEYCODE_TAB -> return "Tab"
    }
    // With the meta state, so a scanner sending an uppercase or symbol code
    // through Shift reports the character it actually typed.
    val unicode = event.getUnicodeChar(event.metaState)
    if (unicode == 0) return null
    return unicode.toChar().toString()
  }

  // Keys that move around the app rather than type into it. Left alone even
  // with nothing focused, so a keyboard case can still reach a field -- and so
  // Back and the volume rocker keep working, which swallowing would break in a
  // way no one would connect to a barcode scanner.
  private fun isNavigation(event: KeyEvent): Boolean = when (event.keyCode) {
    KeyEvent.KEYCODE_TAB,
    KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN,
    KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_BACK,
    KeyEvent.KEYCODE_ESCAPE, KeyEvent.KEYCODE_MENU,
    KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN -> true
    else -> false
  }

  private fun startCapture() {
    main.post {
      val window = appContext.currentActivity?.window ?: return@post
      if (wrappedWindow === window) return@post
      wrappedWindow = window
      val base = window.callback ?: return@post
      previousCallback = base
      window.callback = object : Window.Callback by base {
        override fun dispatchKeyEvent(event: KeyEvent): Boolean {
          // A field the user tapped owns its own keys, and resolves its own
          // scans through `stepFieldBurst`. Yielding to it is the one rule this
          // whole design turns on -- and it is a CHECK, evaluated here against
          // the view that actually holds focus, rather than a fight over the
          // caret. `onCheckIsTextEditor` is what the IME itself asks, so the
          // answer cannot drift from what Android believes.
          val editorFocused = window.currentFocus?.onCheckIsTextEditor() == true
          if (editorFocused) return base.dispatchKeyEvent(event)

          // Read for both halves of the pair -- the swallow below needs it --
          // but REPORTED on the down alone: a scanner's key arrives as a
          // down/up pair, and sending both would double every character.
          val name = keyName(event)
          if (event.action == KeyEvent.ACTION_DOWN && name != null) {
            // `eventTime` rather than a clock read in JS: the burst rules turn
            // on gaps of a few milliseconds, and a value stamped when the key
            // was actually delivered survives a busy bridge that a later
            // `Date.now()` would not.
            sendEvent("onKey", mapOf("key" to name, "at" to event.eventTime.toDouble()))
          }

          // With no editor focused there is nothing in this app that hardware
          // characters legitimately belong to, and letting them through is not
          // harmless: Android focuses the first focusable view to deliver them,
          // so a scan's trailing Enter presses whatever that turns out to be --
          // observed opening the photo picker from Inventory. The web half
          // prevents exactly this with `preventDefault` on the scan's keys.
          //
          // Both halves of the pair are swallowed, or the view sees an ACTION_UP
          // for a key it never received. Navigation keys are deliberately NOT
          // swallowed: Tab and the arrows are how someone with a keyboard case
          // reaches a field in the first place, and taking those would trade one
          // trapped user for another.
          return if (name != null && !isNavigation(event)) true else base.dispatchKeyEvent(event)
        }
      }
    }
  }

  private fun stopCapture() {
    main.post {
      // Restored on the window that was actually wrapped. Handing the old
      // callback to a NEW window would graft a dead Activity's chain onto a
      // live one.
      wrappedWindow?.let { window -> previousCallback?.let { window.callback = it } }
      wrappedWindow = null
      previousCallback = null
    }
  }

  // ---------------------------------------------------------------------------
  // Typing INTO the app, which is the other half of a till with a scanner
  // plugged in: Android refuses to show its own keyboard while one is attached,
  // so the app carries a keypad of its own. That keypad used to own a value and
  // write to it, which is why it served exactly one field -- the search box --
  // and left the discount, the customer search, and every form field on the
  // till untypeable.
  //
  // A keyboard does not own a value. It sends characters to whatever has focus,
  // and lets the field decide what that means. Doing the same here is what makes
  // one dock serve every input in the app without a single field knowing it
  // exists.

  // The focused editor, addressed by React tag when the caller knows it.
  //
  // `window.currentFocus` only ever answers for the ACTIVITY's window, and a
  // React Native modal is a window of its own -- so every field inside a sheet
  // (the customer search, a product form, the float count) was invisible to it,
  // which is precisely where a till most needs a keyboard. The tag comes from
  // React and does not care which window the view was mounted into.
  private fun editorFor(tag: Int): EditText? {
    val byTag = if (tag == NO_TAG) null else appContext.findView<View>(tag)
    if (byTag is EditText) return byTag
    return appContext.currentActivity?.window?.currentFocus as? EditText
  }

  private val focusedEditor: EditText?
    get() = editorFor(NO_TAG)

  // Typing must not cost the field its focus. A key goes in, the app re-renders
  // around the new value -- a customer search re-runs, a list under it changes --
  // and a field that comes out of that unfocused takes the dock down with it,
  // because the dock follows focus. Observed exactly that: the first key landed
  // and the keyboard vanished. Re-asserting focus after the edit is what keeps
  // the second key possible.
  private fun keepFocus(editor: EditText) {
    if (!editor.isFocused) editor.requestFocus()
  }

  private fun insertText(text: String, tag: Int) {
    main.post {
      val editor = editorFor(tag) ?: return@post
      keepFocus(editor)
      // Through the selection rather than appending, so the keypad respects a
      // caret the user has moved and replaces a selection they have made --
      // the things that make an editor an editor rather than a text sink.
      val start = editor.selectionStart.coerceAtLeast(0)
      val end = editor.selectionEnd.coerceAtLeast(0)
      editor.text.replace(start.coerceAtMost(end), start.coerceAtLeast(end), text)
    }
  }

  // The Enter a scanner sends after a code, from a finger instead. Without it a
  // code typed by hand can be entered but never committed, which is a real till
  // workflow -- reading a damaged barcode off the label.
  //
  // A real key event dispatched at the field, so it travels the path the
  // scanner's own terminator travels and the field's `onSubmitEditing` fires
  // exactly as it would for hardware. Sent to the view rather than the window,
  // so the capture wrapper is not involved at all.
  private fun pressEnter(tag: Int) {
    main.post {
      val editor = editorFor(tag) ?: return@post
      keepFocus(editor)
      val now = SystemClock.uptimeMillis()
      editor.dispatchKeyEvent(KeyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0))
      editor.dispatchKeyEvent(KeyEvent(now, now, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER, 0))
    }
  }

  private fun deleteBackward(tag: Int) {
    main.post {
      val editor = editorFor(tag) ?: return@post
      keepFocus(editor)
      val start = editor.selectionStart.coerceAtLeast(0)
      val end = editor.selectionEnd.coerceAtLeast(0)
      if (start != end) {
        editor.text.delete(start.coerceAtMost(end), start.coerceAtLeast(end))
      } else if (start > 0) {
        editor.text.delete(start - 1, start)
      }
    }
  }

  // Focus, reported from the one place that actually knows. The dock has to
  // appear when a field is ready for typing and leave when it is not, and every
  // JS-side approximation of that -- a prop on each field, a cache read at
  // render time -- is a copy that drifts.
  private val focusListener = ViewTreeObserver.OnGlobalFocusChangeListener { _, newFocus ->
    sendEvent("onEditorFocus", mapOf("focused" to (newFocus is EditText)))
  }

  private var watchingFocus = false
  private var watchedDecor: View? = null

  private fun startFocusWatch() {
    main.post {
      val decor = appContext.currentActivity?.window?.decorView ?: return@post
      if (watchedDecor === decor) return@post
      watchedDecor = decor
      decor.viewTreeObserver.addOnGlobalFocusChangeListener(focusListener)
    }
  }

  private fun stopFocusWatch() {
    main.post {
      watchedDecor?.viewTreeObserver?.removeOnGlobalFocusChangeListener(focusListener)
      watchedDecor = null
    }
  }

  override fun definition() = ModuleDefinition {
    Name("HardwareKeyboard")

    Events("onChange", "onKey", "onEditorFocus")

    // The keypad's two verbs. Deliberately not "setValue": a keyboard that set
    // values would have to know which field it was aimed at, which is the
    // limitation this replaces.
    Function("insertText") { text: String, tag: Int -> insertText(text, tag) }
    Function("deleteBackward") { tag: Int -> deleteBackward(tag) }
    Function("pressEnter") { tag: Int -> pressEnter(tag) }
    // Answers for the first render, before any focus CHANGE has happened.
    Function("isEditorFocused") { focusedEditor != null }

    Function("isAttached") { isAttached() }

    // Absent from binaries built before key capture existed, which is exactly
    // how the JS half tells whether it may retire the invisible sink. A `true`
    // that can only come from this build is more honest than a version number
    // nobody remembers to raise.
    Function("supportsKeyEvents") { true }

    // Per event, not per module: the window is wrapped only while something is
    // actually listening for keys, so a till with scanning switched off runs
    // with the callback chain it was born with.
    OnStartObserving("onChange") { inputManager?.registerInputDeviceListener(listener, null) }
    OnStopObserving("onChange") { inputManager?.unregisterInputDeviceListener(listener) }

    OnStartObserving("onKey") { capturing = true; startCapture() }
    OnStopObserving("onKey") { capturing = false; stopCapture() }

    OnStartObserving("onEditorFocus") { watchingFocus = true; startFocusWatch() }
    OnStopObserving("onEditorFocus") { watchingFocus = false; stopFocusWatch() }

    // The Activity this app runs in is not forever: a dev reload replaces it, and
    // so does a rotation or any other configuration change. Both listeners live
    // on the Activity's window, so both have to be re-attached to whatever
    // window is in front now -- otherwise a till keeps running, looks fine, and
    // never sees another scan.
    OnActivityEntersForeground {
      if (capturing) startCapture()
      if (watchingFocus) startFocusWatch()
    }
  }
}
