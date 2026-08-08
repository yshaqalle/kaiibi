package expo.modules.hardwarekeyboard

import android.content.Context
import android.hardware.input.InputManager
import android.view.InputDevice
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Is a physical keyboard attached to THIS device? See the iOS twin for why
// this reports a keyboard and never a scanner.
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

  override fun definition() = ModuleDefinition {
    Name("HardwareKeyboard")

    Events("onChange")

    Function("isAttached") { isAttached() }

    OnStartObserving { inputManager?.registerInputDeviceListener(listener, null) }

    OnStopObserving { inputManager?.unregisterInputDeviceListener(listener) }
  }
}
