package expo.modules.kkchatnative

import androidx.core.content.FileProvider

/** 独立的 FileProvider 子类，避免与其他库的 provider 声明冲突。 */
class KkchatUpdateFileProvider : FileProvider()
