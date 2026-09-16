// dsh-cua — screenshots and application listing
//
// Screenshots use ScreenCaptureKit. macOS 26 removed CGWindowListCreateImage, so
// the older path is not an option here. Capture is permission-gated by TCC
// ("Screen Recording"); when it is not granted we surface the exact reason and
// the tree-only mode still works.

import Foundation
import AppKit
import CoreGraphics
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

// MARK: - Screenshot

func screenshotDirectory() -> URL {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("dsh-cua-shots")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

/// Capture the display, optionally cropping to a window's bounds.
///
/// Returns a `file://` URL. Images are downscaled because they are read back into
/// the model context, where an unscaled retina PNG is pure token cost.
/// Whether the login session's screen is currently locked.
///
/// This matters because macOS reports zero *active* displays while locked, which
/// is what makes ScreenCaptureKit find nothing to capture. Distinguishing it
/// from a permission failure is the difference between an actionable message and
/// a misleading one.
func isScreenLocked() -> Bool {
    guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    if let locked = dict["CGSSessionScreenIsLocked"] as? Bool, locked { return true }
    if let locked = dict["CGSSessionScreenIsLocked"] as? Int, locked != 0 { return true }
    return false
}

func activeDisplayCount() -> Int {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    return Int(count)
}

func captureScreenshot(cropTo windowBounds: CGRect? = nil) throws -> (url: String, note: String?) {
    // Screen capture of a locked session is blocked by macOS by design. Report
    // that precisely rather than letting it surface as an empty capture.
    if isScreenLocked() {
        throw DshError.screenshot(
            "The screen is locked, so screen capture is unavailable (macOS blocks capture of a locked session). " +
            "Accessibility-based operation still works: the accessibility tree can be read and UI actions can be performed. " +
            "Unlock the Mac to enable screenshots."
        )
    }
    if activeDisplayCount() == 0 {
        throw DshError.screenshot(
            "No active display is available to capture. The displays are asleep, or the session is in a state where " +
            "macOS exposes no active display. The accessibility tree is still usable."
        )
    }

    let sem = DispatchSemaphore(value: 0)
    var outcome: Result<CGImage, Error>?

    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else {
                outcome = .failure(DshError.screenshot(
                    "ScreenCaptureKit reported no capturable display (it found \(content.windows.count) windows but 0 displays). " +
                    "This normally means the screen is locked or the displays are asleep."
                ))
                sem.signal(); return
            }
            let cfg = SCStreamConfiguration()
            cfg.width = display.width
            cfg.height = display.height
            cfg.showsCursor = false
            cfg.captureResolution = .best

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
            outcome = .success(image)
        } catch {
            outcome = .failure(error)
        }
        sem.signal()
    }

    // macOS can leave this call hanging while it waits on a Screen Recording
    // permission prompt that the user has not answered. Failing at 8s with a
    // message that names that possibility is far more useful than blocking for
    // 25s and then reporting only a timeout.
    guard sem.wait(timeout: .now() + 8) == .success else {
        throw DshError.screenshot(
            "Screen capture did not respond within 8s. macOS blocks this call while it waits for a Screen Recording " +
            "permission decision — check for a system prompt, or grant it in System Settings > Privacy & Security > " +
            "Screen Recording for DSH Desktop. The accessibility tree is unaffected, so text-only operation still works."
        )
    }

    let image: CGImage
    switch outcome {
    case .success(let img): image = img
    case .failure(let err):
        throw DshError.screenshot(describeCaptureFailure(err))
    case nil:
        throw DshError.screenshot("Screen capture produced no result")
    }

    // Crop to the window when we know where it is. The captured bitmap is in
    // pixels; window bounds are in points, so scale.
    var final = image
    var note: String?
    if let b = windowBounds {
        let scaleX = CGFloat(image.width) / CGFloat(NSScreen.main?.frame.width ?? CGFloat(image.width))
        let pixelRect = CGRect(x: b.origin.x * scaleX, y: b.origin.y * scaleX,
                               width: b.width * scaleX, height: b.height * scaleX)
        if let cropped = image.cropping(to: pixelRect.integral) {
            final = cropped
        } else {
            note = "window crop failed; returned the full display"
        }
    }

    // Downscale so the image stays cheap in context.
    final = downscale(final, maxWidth: 1280)

    let name = "shot-\(Int(Date().timeIntervalSince1970 * 1000))-\(UInt32.random(in: 0..<9999)).png"
    let url = screenshotDirectory().appendingPathComponent(name)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        throw DshError.screenshot("Could not create the PNG destination")
    }
    CGImageDestinationAddImage(dest, final, nil)
    guard CGImageDestinationFinalize(dest) else {
        throw DshError.screenshot("Could not write the screenshot")
    }
    return ("file://\(url.path)", note)
}

private func downscale(_ image: CGImage, maxWidth: Int) -> CGImage {
    guard image.width > maxWidth else { return image }
    let scale = Double(maxWidth) / Double(image.width)
    let h = Int(Double(image.height) * scale)
    guard let ctx = CGContext(data: nil, width: maxWidth, height: h,
                              bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue) else { return image }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: maxWidth, height: h))
    return ctx.makeImage() ?? image
}

/// Turn a ScreenCaptureKit failure into something the model (and the user) can act on.
func describeCaptureFailure(_ error: Error) -> String {
    let text = String(describing: error)
    if text.contains("TCC") || text.contains("declined") || text.contains("denied") || text.contains("not authorized") {
        return """
        Screen capture is blocked by macOS privacy settings (Screen Recording).
        The accessibility tree is still available, so text-only operation works.
        To enable screenshots: System Settings > Privacy & Security > Screen Recording, \
        add and enable DSH Desktop, then restart it.
        Raw error: \(text)
        """
    }
    if text.contains("userDeclined") {
        return "Screen capture was declined by the user. Screenshots stay unavailable until Screen Recording is granted to DSH Desktop."
    }
    return "Screen capture failed: \(text)"
}

// MARK: - Window geometry

/// On-screen bounds of a window belonging to `pid`, in points.
func windowBounds(pid: pid_t, titleHint: String?) -> CGRect? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    var best: CGRect?
    for entry in list {
        guard let owner = entry[kCGWindowOwnerPID as String] as? pid_t, owner == pid else { continue }
        guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { continue }
        // Skip tiny chrome (shadow, tooltip) and offscreen entries.
        guard rect.width > 120, rect.height > 80 else { continue }
        let layer = entry[kCGWindowLayer as String] as? Int ?? 0
        guard layer == 0 else { continue }

        if let hint = titleHint, let name = entry[kCGWindowName as String] as? String, name == hint {
            return rect
        }
        // Prefer the largest window when no title hint matches.
        if best == nil || rect.width * rect.height > best!.width * best!.height {
            best = rect
        }
    }
    return best
}

// MARK: - App listing

struct AppInfo {
    let id: String
    let displayName: String
    let lastUsedDate: String?
    let useCount: Int?
    let isRunning: Bool
}

/// Enumerate launchable applications, preferring Spotlight's usage metadata when
/// it is available (macOS keeps last-used date and launch count there).
func listApplications() -> [AppInfo] {
    var results: [String: AppInfo] = [:]
    let running = NSWorkspace.shared.runningApplications
    // Several processes can share a bundle id (helper processes, multiple windows
    // of the same app), so collapse them rather than assuming uniqueness.
    var runningByBundle: [String: NSRunningApplication] = [:]
    for app in running {
        guard let b = app.bundleIdentifier else { continue }
        if runningByBundle[b] == nil { runningByBundle[b] = app }
    }

    let roots = ["/Applications", "/System/Applications",
                 "/System/Applications/Utilities", "/Applications/Utilities",
                 NSHomeDirectory() + "/Applications"]

    for root in roots {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: root) else { continue }
        for entry in entries where entry.hasSuffix(".app") {
            let path = "\(root)/\(entry)"
            guard let bundle = Bundle(path: path), let bundleId = bundle.bundleIdentifier else { continue }
            if results[bundleId] != nil { continue }

            let name = (bundle.infoDictionary?["CFBundleDisplayName"] as? String)
                ?? (bundle.infoDictionary?["CFBundleName"] as? String)
                ?? String(entry.dropLast(4))

            let runningApp = runningByBundle[bundleId]
            results[bundleId] = AppInfo(
                id: bundleId,
                displayName: name,
                lastUsedDate: usageDate(for: bundleId),
                useCount: nil,
                isRunning: runningApp != nil
            )
        }
    }

    // Apps that are running but live outside the standard roots still matter.
    // System service processes (XPC helpers, Safari platform helpers, per-app
    // panels) must not pollute the list: they are not launchable apps and they
    // make name-based resolution ambiguous.
    for app in running {
        guard let b = app.bundleIdentifier, results[b] == nil, let name = app.localizedName else { continue }
        guard isLaunchableApp(bundleId: b, bundlePath: app.bundleURL?.path) else { continue }
        results[b] = AppInfo(id: b, displayName: name, lastUsedDate: nil, useCount: nil, isRunning: true)
    }

    return results.values.sorted { $0.displayName.lowercased() < $1.displayName.lowercased() }
}

/// Heuristic that separates real applications from macOS service processes.
func isLaunchableApp(bundleId: String, bundlePath: String?) -> Bool {
    // XPC services are implementation details, never user-facing apps.
    if bundleId.contains(".xpc.") { return false }
    if bundleId.hasPrefix("com.apple.SafariPlatformSupport") { return false }
    if bundleId.hasPrefix("com.apple.WebKit") { return false }
    if bundleId.hasPrefix("com.apple.appkit") { return false }
    // Helper processes carry these markers in their bundle id.
    let lowered = bundleId.lowercased()
    if lowered.hasSuffix(".helper") || lowered.contains(".helper.") { return false }
    // A real app bundle has a path ending in .app; anything else is a service.
    if let path = bundlePath, !path.hasSuffix(".app") { return false }
    // Require a dotted, plausible reverse-DNS identifier.
    let parts = bundleId.split(separator: ".")
    if parts.count < 2 { return false }
    // Reject UUID-shaped identifiers, which belong to ad-hoc service bundles.
    if bundleId.range(of: "^[0-9a-fA-F-]{36}$", options: .regularExpression) != nil { return false }
    return true
}

/// Best-effort last-used lookup via Spotlight metadata. Returns nil rather than
/// guessing when the volume does not index application usage.
private func usageDate(for bundleId: String) -> String? {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return nil }
    guard let mdItem = MDItemCreate(kCFAllocatorDefault, url.path as CFString) else { return nil }
    guard let raw = MDItemCopyAttribute(mdItem, kMDItemLastUsedDate) as? Date else { return nil }
    let fmt = ISO8601DateFormatter()
    return fmt.string(from: raw)
}