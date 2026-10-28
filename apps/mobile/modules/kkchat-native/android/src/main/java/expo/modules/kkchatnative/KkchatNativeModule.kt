package expo.modules.kkchatnative

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.util.Consumer
import androidx.window.java.layout.WindowInfoTrackerCallbackAdapter
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import androidx.window.layout.WindowMetricsCalculator
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

private const val LAYOUT_EVENT = "onWindowLayout"

/**
 * KKChat 原生桥：
 * 1. 窗口布局：用 Jetpack WindowManager 的 WindowInfoTracker 读取 FoldingFeature（Surface Duo 铰链、折叠屏折痕），
 *    把 bounds、方向、是否分隔、遮挡类型、状态原样交给 JS 布局层。不按设备型号或屏宽猜。
 * 2. 应用内更新：校验下载的安装包（SHA-256、包名、versionCode、签名证书与当前安装的一致），
 *    再交给系统安装界面，由用户确认。不静默安装，不降级。
 */
class KkchatNativeModule : Module() {
  private var tracker: WindowInfoTrackerCallbackAdapter? = null
  private var trackedActivity: Activity? = null
  private var lastLayout: Map<String, Any?>? = null

  private val layoutListener = Consumer<WindowLayoutInfo> { info ->
    val activity = trackedActivity ?: return@Consumer
    val payload = describe(activity, info)
    lastLayout = payload
    sendEvent(LAYOUT_EVENT, payload)
  }

  override fun definition() = ModuleDefinition {
    Name("KkchatNative")
    Events(LAYOUT_EVENT)

    OnActivityEntersForeground { startTracking() }
    OnActivityEntersBackground { stopTracking() }
    OnActivityDestroys { stopTracking() }
    OnStartObserving { startTracking() }

    Function("getWindowLayout") {
      val activity = appContext.currentActivity ?: return@Function null
      lastLayout ?: describe(activity, null)
    }

    AsyncFunction("sha256File") { path: String ->
      sha256(File(stripScheme(path)))
    }

    AsyncFunction("verifyApk") { path: String, expectedSha256: String ->
      val file = File(stripScheme(path))
      if (!file.exists()) throw CodedException("ERR_APK_MISSING", "安装包不存在", null)
      val digest = sha256(file)
      val context = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "应用未就绪", null)
      val pm = context.packageManager
      val archive = archiveInfo(pm, file.absolutePath)
      val installed = pm.getPackageInfo(context.packageName, signingFlags())
      val archiveSigners = signerDigests(archive)
      val installedSigners = signerDigests(installed)
      val archiveVersion = archive?.let { versionCodeOf(it) } ?: -1L
      val installedVersion = versionCodeOf(installed)
      mapOf(
        "sha256" to digest,
        "sha256Matches" to digest.equals(expectedSha256.trim().lowercase(), ignoreCase = true),
        "packageName" to archive?.packageName,
        "packageMatches" to (archive?.packageName == context.packageName),
        "versionCode" to archiveVersion,
        "installedVersionCode" to installedVersion,
        "isUpgrade" to (archiveVersion > installedVersion),
        "signerSha256" to archiveSigners,
        "signerMatches" to (archiveSigners.isNotEmpty() && archiveSigners.toSet() == installedSigners.toSet()),
      )
    }

    Function("canRequestPackageInstalls") {
      val context = appContext.reactContext ?: return@Function false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) true else context.packageManager.canRequestPackageInstalls()
    }

    Function("openInstallPermissionSettings") {
      val activity = appContext.currentActivity ?: return@Function false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@Function false
      val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
      activity.startActivity(intent)
      true
    }

    /** 只接受缓存 updates 目录里的文件，交给系统安装界面。 */
    Function("installApk") { path: String ->
      val activity = appContext.currentActivity ?: throw CodedException("ERR_NO_ACTIVITY", "应用未在前台", null)
      val file = File(stripScheme(path))
      val updates = File(activity.cacheDir, "updates").canonicalFile
      if (!file.canonicalFile.path.startsWith(updates.path + File.separator)) {
        throw CodedException("ERR_APK_PATH", "安装包路径不在更新目录", null)
      }
      val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.kkchat.updates", file)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      activity.startActivity(intent)
      true
    }

    Function("updatesDirectory") {
      val context = appContext.reactContext ?: return@Function null
      val dir = File(context.cacheDir, "updates")
      dir.mkdirs()
      "file://${dir.absolutePath}/"
    }
  }

  private fun startTracking() {
    val activity = appContext.currentActivity ?: return
    if (trackedActivity === activity && tracker != null) return
    stopTracking()
    val adapter = WindowInfoTrackerCallbackAdapter(WindowInfoTracker.getOrCreate(activity))
    adapter.addWindowLayoutInfoListener(activity, ContextCompat.getMainExecutor(activity), layoutListener)
    tracker = adapter
    trackedActivity = activity
    val initial = describe(activity, null)
    lastLayout = initial
    sendEvent(LAYOUT_EVENT, initial)
  }

  private fun stopTracking() {
    tracker?.removeWindowLayoutInfoListener(layoutListener)
    tracker = null
    trackedActivity = null
  }

  private fun describe(activity: Activity, info: WindowLayoutInfo?): Map<String, Any?> {
    val metrics = WindowMetricsCalculator.getOrCreate().computeCurrentWindowMetrics(activity)
    val bounds = metrics.bounds
    val density = activity.resources.displayMetrics.density
    val features = (info?.displayFeatures ?: emptyList()).filterIsInstance<FoldingFeature>().map { feature ->
      mapOf(
        "left" to feature.bounds.left,
        "top" to feature.bounds.top,
        "right" to feature.bounds.right,
        "bottom" to feature.bounds.bottom,
        "orientation" to if (feature.orientation == FoldingFeature.Orientation.VERTICAL) "vertical" else "horizontal",
        "isSeparating" to feature.isSeparating,
        "occlusion" to if (feature.occlusionType == FoldingFeature.OcclusionType.FULL) "full" else "none",
        "state" to if (feature.state == FoldingFeature.State.HALF_OPENED) "half_opened" else "flat",
      )
    }
    return mapOf(
      "windowWidth" to bounds.width(),
      "windowHeight" to bounds.height(),
      "density" to density,
      "folds" to features,
      "hasLayoutInfo" to (info != null),
    )
  }

  private fun stripScheme(path: String) = if (path.startsWith("file://")) Uri.parse(path).path ?: path else path

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val read = input.read(buffer)
        if (read <= 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun signingFlags(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES

  private fun archiveInfo(pm: PackageManager, path: String): PackageInfo? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      pm.getPackageArchiveInfo(path, PackageManager.PackageInfoFlags.of(signingFlags().toLong()))
    } else {
      @Suppress("DEPRECATION")
      pm.getPackageArchiveInfo(path, signingFlags())
    }

  private fun versionCodeOf(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()

  private fun signerDigests(info: PackageInfo?): List<String> {
    if (info == null) return emptyList()
    val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      info.signingInfo?.let { if (it.hasMultipleSigners()) it.apkContentsSigners else it.signingCertificateHistory }
    } else {
      @Suppress("DEPRECATION")
      info.signatures
    } ?: return emptyList()
    return signatures.map { signature ->
      MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString(":") { "%02X".format(it) }
    }
  }
}
