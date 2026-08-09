Pod::Spec.new do |s|
  s.name           = 'HardwareKeyboard'
  s.version        = '0.1.0'
  s.summary        = 'Reports whether a hardware keyboard is attached'
  s.description    = 'Watches GCKeyboard so the app knows when a physical keyboard — or a HID barcode scanner, which iOS treats as one — connects or disconnects.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
