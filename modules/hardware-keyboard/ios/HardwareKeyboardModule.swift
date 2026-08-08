import ExpoModulesCore
import GameController

// Is a physical keyboard attached to THIS device?
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
public class HardwareKeyboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HardwareKeyboard")

    Events("onChange")

    Function("isAttached") { () -> Bool in
      return GCKeyboard.coalesced != nil
    }

    OnStartObserving {
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

    OnStopObserving {
      NotificationCenter.default.removeObserver(self)
    }
  }

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
}
