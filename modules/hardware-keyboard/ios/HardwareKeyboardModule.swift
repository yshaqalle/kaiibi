import ExpoModulesCore
import GameController
// For `CACurrentMediaTime`, the monotonic clock the key timestamps use.
import QuartzCore

// Is a physical keyboard attached to THIS device, and what is it typing?
//
// A HID barcode scanner is a keyboard as far as the OS is concerned, which is
// the whole reason this exists -- and also why it must never claim to have
// found a *scanner*. It has found a keyboard. Something else decides what that
// means.
//
// GCKeyboard is iOS 14+; the app's deployment target is 16.4 (ios/Podfile), so
// no availability guard is needed.
//
// `coalesced` is the Swift-projected name for Objective-C's `coalescedKeyboard`
// class property, because Swift automatically strips the redundant type-name
// suffix when importing.
//
// The second question -- what is it typing -- is answered from the same place,
// and answering it is what lets the app stop holding the keyboard hostage in an
// invisible focused text field. `keyChangedHandler` delivers hardware keys with
// nothing focused, so a scan lands without any field asking for the caret. See
// the Android twin, which reaches the same result through the window callback.
public class HardwareKeyboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HardwareKeyboard")

    Events("onChange", "onKey")

    Function("isAttached") { () -> Bool in
      return GCKeyboard.coalesced != nil
    }

    // Unlike Android's flat `true`, this asks whether keys can ACTUALLY be
    // delivered right now. GameController does not surface every keyboard --
    // notably not the Mac's in the Simulator -- and answering "yes" where no
    // key will ever arrive would retire the fallback and leave a till that
    // cannot scan at all. No keyboard also means nothing to capture, so `false`
    // there costs nothing.
    Function("supportsKeyEvents") { () -> Bool in
      return GCKeyboard.coalesced != nil
    }

    OnStartObserving("onChange") {
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(self.keyboardDidConnect),
        name: .GCKeyboardDidConnect,
        object: nil
      )
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(self.keyboardDidDisconnect),
        name: .GCKeyboardDidDisconnect,
        object: nil
      )
    }

    OnStopObserving("onChange") {
      NotificationCenter.default.removeObserver(self, name: .GCKeyboardDidConnect, object: nil)
      NotificationCenter.default.removeObserver(self, name: .GCKeyboardDidDisconnect, object: nil)
    }

    OnStartObserving("onKey") {
      self.capturing = true
      self.attachKeyHandler()
      // A scanner paired after the screen opened has to start working without
      // the screen being revisited, which is why capture re-attaches on connect
      // rather than only reading whatever was there at the time.
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(self.keyboardDidConnectForCapture),
        name: .GCKeyboardDidConnect,
        object: nil
      )
    }

    OnStopObserving("onKey") {
      self.capturing = false
      GCKeyboard.coalesced?.keyboardInput?.keyChangedHandler = nil
      NotificationCenter.default.removeObserver(self, name: .GCKeyboardDidConnect, object: self)
    }
  }

  private var capturing = false

  @objc
  private func keyboardDidConnect() {
    sendEvent("onChange", ["attached": true])
  }

  @objc
  private func keyboardDidDisconnect() {
    // Read through rather than assuming false: a device can have two keyboards
    // attached, and one going away does not mean none are left.
    sendEvent("onChange", ["attached": GCKeyboard.coalesced != nil])
  }

  @objc
  private func keyboardDidConnectForCapture() {
    guard capturing else { return }
    attachKeyHandler()
  }

  private func attachKeyHandler() {
    guard let input = GCKeyboard.coalesced?.keyboardInput else { return }
    input.keyChangedHandler = { [weak self] keyboard, _, keyCode, pressed in
      // Presses only. A scanner sends each character as a down/up pair, and
      // reporting both would double every character in the buffer.
      guard pressed, let self else { return }
      let shifted = keyboard.button(forKeyCode: .leftShift)?.isPressed == true
        || keyboard.button(forKeyCode: .rightShift)?.isPressed == true
      guard let key = Self.keyName(keyCode, shifted: shifted) else { return }
      // Monotonic, like Android's `eventTime`: the burst rules turn on gaps of
      // a few milliseconds, and a wall clock can step sideways mid-scan.
      let at = CACurrentMediaTime() * 1000
      self.sendEvent("onKey", ["key": key, "at": at])
    }
  }

  // A `KeyboardEvent.key` value, the DOM's vocabulary -- a single character for
  // printable keys, or a name for the rest -- because the JS half feeds one
  // state machine shared with the web build.
  //
  // Only what a scanner can send. Every symbology in retail use is drawn from
  // digits, letters, and a handful of punctuation; a key outside this table
  // returns nil and the burst simply does not see it, which is the same
  // treatment `stepWedge` gives modifiers and arrows anyway.
  private static func keyName(_ code: GCKeyCode, shifted: Bool) -> String? {
    if code == .returnOrEnter || code == .keypadEnter { return "Enter" }
    if code == .tab { return "Tab" }
    if code == .spacebar { return " " }

    let letters: [GCKeyCode: String] = [
      .keyA: "a", .keyB: "b", .keyC: "c", .keyD: "d", .keyE: "e", .keyF: "f",
      .keyG: "g", .keyH: "h", .keyI: "i", .keyJ: "j", .keyK: "k", .keyL: "l",
      .keyM: "m", .keyN: "n", .keyO: "o", .keyP: "p", .keyQ: "q", .keyR: "r",
      .keyS: "s", .keyT: "t", .keyU: "u", .keyV: "v", .keyW: "w", .keyX: "x",
      .keyY: "y", .keyZ: "z",
    ]
    if let letter = letters[code] {
      return shifted ? letter.uppercased() : letter
    }

    // Unshifted digits and their shifted symbols, as a US layout sends them.
    // A scanner is a keyboard emulating that layout unless someone has
    // configured it otherwise, which is a shop-specific problem no table here
    // can answer.
    let digits: [GCKeyCode: (String, String)] = [
      .one: ("1", "!"), .two: ("2", "@"), .three: ("3", "#"), .four: ("4", "$"),
      .five: ("5", "%"), .six: ("6", "^"), .seven: ("7", "&"), .eight: ("8", "*"),
      .nine: ("9", "("), .zero: ("0", ")"),
    ]
    if let pair = digits[code] {
      return shifted ? pair.1 : pair.0
    }

    let keypad: [GCKeyCode: String] = [
      .keypad1: "1", .keypad2: "2", .keypad3: "3", .keypad4: "4", .keypad5: "5",
      .keypad6: "6", .keypad7: "7", .keypad8: "8", .keypad9: "9", .keypad0: "0",
    ]
    if let digit = keypad[code] { return digit }

    let punctuation: [GCKeyCode: (String, String)] = [
      .hyphen: ("-", "_"), .equalSign: ("=", "+"), .period: (".", ">"),
      .comma: (",", "<"), .slash: ("/", "?"), .semicolon: (";", ":"),
      .quote: ("'", "\""), .backslash: ("\\", "|"),
      .openBracket: ("[", "{"), .closeBracket: ("]", "}"),
    ]
    if let pair = punctuation[code] {
      return shifted ? pair.1 : pair.0
    }

    return nil
  }
}
