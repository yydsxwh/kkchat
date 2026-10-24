Pod::Spec.new do |s|
  s.name           = 'KkchatNative'
  s.version        = '1.0.0'
  s.summary        = 'KKChat window layout bridge'
  s.description    = 'Reports window metrics to the KKChat layout layer.'
  s.author         = 'YYDSXWH'
  s.homepage       = 'https://kkchat.yydsxwh.com'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
