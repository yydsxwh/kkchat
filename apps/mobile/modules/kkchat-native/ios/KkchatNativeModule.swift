import ExpoModulesCore
import UIKit

/// iOS 没有铰链类 FoldingFeature：只上报窗口尺寸，布局层按可用宽度决定是否分栏（iPad 分屏同理）。
/// iOS 应用只能经 App Store / TestFlight 安装与更新，不提供安装包相关能力。
public class KkchatNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KkchatNative")
    Events("onWindowLayout")

    Function("getWindowLayout") { () -> [String: Any] in
      let bounds = UIScreen.main.bounds
      let scale = UIScreen.main.scale
      return [
        "windowWidth": bounds.width * scale,
        "windowHeight": bounds.height * scale,
        "density": scale,
        "folds": [],
        "hasLayoutInfo": true,
      ]
    }

    Function("canRequestPackageInstalls") { () -> Bool in
      false
    }

    Function("updatesDirectory") { () -> String? in
      nil
    }
  }
}
