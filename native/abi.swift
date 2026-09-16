// dsh-cua — C ABI surface
//
// The N-API addon calls into these functions. Everything crosses the boundary as
// JSON so the binding stays thin and the operations stay testable from a plain
// Swift harness.

import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

private let isoFormatter = ISO8601DateFormatter()

// MARK: - JSON helpers

private func jsonEscape(_ s: String) -> String {
    var out = ""
    out.reserveCapacity(s.count + 16)
    for ch in s.unicodeScalars {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if ch.value < 0x20 {
                out += String(format: "\\u%04x", ch.value)
            } else {
                out.unicodeScalars.append(ch)
            }
        }
    }
    return out
}

func jsonString(_ s: String) -> String { "\"\(jsonEscape(s))\"" }

func jsonObject(_ pairs: [(String, String)]) -> String {
    "{" + pairs.map { "\(jsonString($0.0)):\($0.1)" }.joined(separator: ",") + "}"
}

func ok(_ pairs: [(String, String)]) -> String {
    jsonObject([("ok", "true")] + pairs)
}

func fail(_ message: String, code: String = "ERROR") -> String {
    jsonObject([("ok", "false"), ("error", jsonString(message)), ("code", jsonString(code))])
}

func optString(_ s: String?) -> String {
    guard let s = s else { return "null" }
    return jsonString(s)
}

func optDouble(_ d: Double?) -> String {
    guard let d = d else { return "null" }
    return String(d)
}

func optInt(_ i: Int?) -> String {
    guard let i = i else { return "null" }
    return String(i)
}

// MARK: - Parameter extraction
//
// Requests arrive as a JSON object. Rather than pulling in a decoder for a
// handful of fields, parse the small object directly — the schema is ours.

final class Params {
    private var values: [String: Any] = [:]

    init(_ json: String) {
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        values = obj
    }

    func string(_ key: String) -> String? { values[key] as? String }

    /// Required, non-empty. For identifiers where an empty value is meaningless
    /// (an app reference, a key name).
    func requiredString(_ key: String) throws -> String {
        guard let v = values[key] as? String, !v.isEmpty else {
            throw DshError.action("Missing required parameter \"\(key)\"")
        }
        return v
    }

    /// Required, but an empty string is a legitimate value.
    ///
    /// Clearing a text field via `set_value` and typing an empty string are both
    /// real operations, so rejecting "" here would make them impossible.
    func requiredStringAllowEmpty(_ key: String) throws -> String {
        guard values[key] != nil else {
            throw DshError.action("Missing required parameter \"\(key)\"")
        }
        guard let v = values[key] as? String else {
            throw DshError.action("Parameter \"\(key)\" must be a string")
        }
        return v
    }
    func int(_ key: String) -> Int? {
        if let i = values[key] as? Int { return i }
        if let d = values[key] as? Double { return Int(d) }
        if let s = values[key] as? String { return Int(s) }
        return nil
    }
    func double(_ key: String) -> Double? {
        if let d = values[key] as? Double { return d }
        if let i = values[key] as? Int { return Double(i) }
        if let s = values[key] as? String { return Double(s) }
        return nil
    }
    func bool(_ key: String) -> Bool? { values[key] as? Bool }
    func has(_ key: String) -> Bool { values[key] != nil }
}

/// Human-readable text for any error crossing the boundary.
///
/// Note: `IndexError` declares a `message` property, but string interpolation of
/// an arbitrary `Error` picks up the standard `LocalizedError` behaviour and
/// yields the raw enum case instead. Resolving the cases explicitly keeps the
/// guidance the model sees intact.
func describeError(_ error: Error) -> String {
    switch error {
    case let e as DshError: return e.message
    case let e as IndexError: return e.message
    default: return String(describing: error)
    }
}

private func requireApp(_ p: Params) throws -> NSRunningApplication {
    if let pid = p.int("pid") {
        guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else {
            throw DshError.notFound("No running application has pid \(pid)")
        }
        return app
    }
    let ref = try p.requiredString("app")
    guard let app = resolveApp(ref) else {
        throw DshError.notFound("No application matched \"\(ref)\". Try list_apps() to see what is available, or pass a bundle identifier such as \"com.apple.finder\".")
    }
    return app
}

// MARK: - Exported operations

@_cdecl("dsh_cua_is_trusted")
public func dsh_cua_is_trusted() -> Int32 {
    return AXIsProcessTrusted() ? 1 : 0
}

@_cdecl("dsh_cua_get_app_state")
public func dsh_cua_get_app_state(_ json: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    let p = Params(json.map { String(cString: $0) } ?? "{}")
    do {
        let app = try requireApp(p)
        let disableDiff = p.bool("disableDiff") ?? false
        let wantShot = p.bool("screenshot") ?? true
        let key = snapshotKey(app)
        let appName = app.localizedName ?? key

        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        var windowsRef: CFTypeRef?
        let werr = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef)
        guard werr == .success else {
            throw DshError.action("Could not read windows for \(appName) (AXError \(werr.rawValue)). The app may not be fully launched yet, or accessibility access is missing.")
        }
        let windows = (windowsRef as? [AXUIElement]) ?? []
        guard let window = windows.first else {
            throw DshError.action("\(appName) has no open windows. Launch or activate it first; get_app_state can also launch apps that are not running.")
        }

        let walked = walkWindow(window)
        let previous = snapshotCache[key]

        // Publish the new snapshot. Indices from the old one are now invalid.
        let snap = AppSnapshot(appKey: key)
        snap.nodes = walked.nodes
        snap.lines = walked.lines
        snapshotCache[key] = snap

        // Window title and geometry.
        let title = axString(window, kAXTitleAttribute as String)
        var sizeText = ""
        if let s = axSize(window) { sizeText = "\(Int(s.width))x\(Int(s.height))" }

        // Diff against the previous render, unless a full tree was requested.
        let useFull = disableDiff || previous == nil
        var text: String
        var isDiff = false
        if useFull {
            text = walked.lines.joined(separator: "\n")
        } else {
            let (d, truncatedToFull) = diffLines(previous!.lines, walked.lines)
            text = d
            isDiff = !truncatedToFull
        }

        let truncated = walked.truncated
        if walked.truncated {
            text += "\n… tree truncated at \(walked.nodes.count) elements. Pass a narrower target (for example a specific window) to see the rest."
        }

        var shotJson = "null"
        var shotNote: String?
        if wantShot {
            let bounds = windowBounds(pid: app.processIdentifier, titleHint: title.isEmpty ? nil : title)
            do {
                let (url, note) = try captureScreenshot(cropTo: bounds)
                shotJson = jsonObject([("url", jsonString(url))])
                shotNote = note
            } catch {
                // Screenshot is optional; AX text remains the primary channel.
                shotNote = describeError(error)
            }
        }

        return strdup(jsonObject([
            ("ok", "true"),
            ("app", jsonString(appName)),
            ("key", jsonString(key)),
            ("title", jsonString(title)),
            ("windowSize", jsonString(sizeText)),
            ("elementCount", String(walked.nodes.count)),
            ("isDiff", isDiff ? "true" : "false"),
            ("truncated", truncated ? "true" : "false"),
            ("text", jsonString(text)),
            ("screenshot", shotJson),
            ("screenshotNote", optString(shotNote)),
        ]))
    } catch {
        let msg = describeError(error)
        return strdup(fail(msg, code: "GET_APP_STATE"))
    }
}

@_cdecl("dsh_cua_list_apps")
public func dsh_cua_list_apps(_ json: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    let apps = listApplications()
    let items = apps.map { a in
        jsonObject([
            ("id", jsonString(a.id)),
            ("displayName", jsonString(a.displayName)),
            ("lastUsedDate", optString(a.lastUsedDate)),
            ("useCount", optInt(a.useCount)),
            ("isRunning", a.isRunning ? "true" : "false"),
        ])
    }
    return strdup(ok([("apps", "[" + items.joined(separator: ",") + "]")]))
}

/// Dispatch a single UI action. Kept as one entry point so the N-API binding and
/// the test harness share exactly one code path.
@_cdecl("dsh_cua_action")
public func dsh_cua_action(_ name: UnsafePointer<CChar>?, _ json: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    let op = name.map { String(cString: $0) } ?? ""
    let p = Params(json.map { String(cString: $0) } ?? "{}")

    do {
        switch op {
        case "click":
            let app = try requireApp(p)
            let idx = p.int("element_index")
            var point: CGPoint?
            if let x = p.double("x"), let y = p.double("y") { point = CGPoint(x: x, y: y) }
            guard idx != nil || point != nil else {
                throw DshError.action("click requires element_index, or x and y together")
            }
            let msg = try performClick(app: app, elementIndex: idx, point: point,
                                       button: p.string("mouse_button") ?? "left",
                                       clickCount: p.int("click_count") ?? 1)
            return strdup(ok([("message", jsonString(msg))]))

        case "set_value":
            let app = try requireApp(p)
            guard let idx = p.int("element_index") else { throw DshError.action("set_value requires element_index") }
            let value = try p.requiredStringAllowEmpty("value")
            return strdup(ok([("message", jsonString(try performSetValue(app: app, elementIndex: idx, value: value)))]))

        case "select_text":
            let app = try requireApp(p)
            guard let idx = p.int("element_index") else { throw DshError.action("select_text requires element_index") }
            let text = try p.requiredString("text")
            let msg = try performSelectText(app: app, elementIndex: idx, text: text,
                                            prefix: p.string("prefix"), suffix: p.string("suffix"),
                                            selectionType: p.string("selection_type") ?? "text")
            return strdup(ok([("message", jsonString(msg))]))

        case "perform_secondary_action":
            let app = try requireApp(p)
            guard let idx = p.int("element_index") else { throw DshError.action("perform_secondary_action requires element_index") }
            let action = try p.requiredString("action")
            return strdup(ok([("message", jsonString(try performSecondaryAction(app: app, elementIndex: idx, action: action)))]))

        case "type_text":
            let app = try requireApp(p)
            try activate(app)
            let text = p.string("text") ?? ""
            // Wait for focus before synthesizing keystrokes: events are delivered
            // to the focused element, so typing too early silently loses input.
            let focus = waitForFocus(app)
            let typed = try postText(text)
            var message = typed
            if !focus.focused {
                message += " \u{2014} warning: the app did not take keyboard focus within \(focus.waitedMs)ms, so the text may not have landed. Click a text field first, or check which window is frontmost."
            } else if !text.isEmpty, let landed = focusedValue(of: app) {
                // Read back so a silent mismatch is reported rather than assumed away.
                if landed != text && !landed.hasSuffix(text) {
                    message += " \u{2014} note: the focused field now reads \"\(landed)\", which does not end with the text sent. The app may have transformed or truncated the input."
                }
            }
            return strdup(ok([("message", jsonString(message))]))

        case "press_key":
            let app = try requireApp(p)
            try activate(app)
            let key = try p.requiredString("key")
            let focus = waitForFocus(app, timeoutMs: 1500)
            let pressed = try postKeyChord(key)
            let msg = focus.focused
                ? pressed
                : "\(pressed) \u{2014} warning: the app did not take keyboard focus within \(focus.waitedMs)ms; the keystroke may not have been delivered."
            return strdup(ok([("message", jsonString(msg))]))

        case "paste":
            let app = try requireApp(p)
            try activate(app)
            let text = p.string("text") ?? ""
            let format = p.string("format") ?? "text"
            return strdup(ok([("message", jsonString(try postPaste(text, format: format)))]))

        case "scroll":
            let app = try requireApp(p)
            var point: CGPoint?
            if let x = p.double("x"), let y = p.double("y") { point = CGPoint(x: x, y: y) }
            let msg = try performScroll(app: app, elementIndex: p.int("element_index"), point: point,
                                        direction: p.string("direction") ?? "down",
                                        pages: p.double("pages") ?? 1)
            return strdup(ok([("message", jsonString(msg))]))

        case "drag":
            let app = try requireApp(p)
            guard let fx = p.double("from_x"), let fy = p.double("from_y"),
                  let tx = p.double("to_x"), let ty = p.double("to_y") else {
                throw DshError.action("drag requires from_x, from_y, to_x and to_y")
            }
            _ = app
            try postDrag(from: CGPoint(x: fx, y: fy), to: CGPoint(x: tx, y: ty))
            return strdup(ok([("message", jsonString("dragged from \(Int(fx)),\(Int(fy)) to \(Int(tx)),\(Int(ty))"))]))

        case "screenshot":
            do {
                let (url, note) = try captureScreenshot()
                return strdup(ok([("url", jsonString(url)), ("note", optString(note))]))
            } catch {
                throw error
            }

        default:
            throw DshError.action("Unknown action \"\(op)\"")
        }
    } catch {
        let msg = describeError(error)
        return strdup(fail(msg, code: op.isEmpty ? "ERROR" : op.uppercased()))
    }
}

/// Bring an app forward before synthesizing input. Events go to the focused app,
/// so typing into a background app would otherwise land in the wrong place.
private func activate(_ app: NSRunningApplication) throws {
    if app.isActive { return }
    app.activate(options: [])
    // Wait briefly for focus to settle.
    for _ in 0..<20 {
        usleep(25_000)
        if app.isActive { return }
    }
}

@_cdecl("dsh_cua_preflight")
public func dsh_cua_preflight() -> UnsafeMutablePointer<CChar>? {
    let trusted = AXIsProcessTrusted()
    let locked = isScreenLocked()
    let activeDisplays = activeDisplayCount()

    var shotOk = false
    var shotDetail = ""
    do {
        _ = try captureScreenshot(cropTo: nil)
        shotOk = true
        shotDetail = "screen capture available"
    } catch {
        shotDetail = describeError(error)
    }

    var appCount = 0
    if trusted {
        appCount = NSWorkspace.shared.runningApplications.count
    }

    // Explain why screen capture is unavailable, because the remedy differs
    // completely between a locked session, a sleeping display, and a missing
    // privacy permission. A vague message here sends the user to the wrong
    // settings pane.
    let guidance: String = {
        if !trusted {
            return "Accessibility is NOT available, so Computer Use cannot operate. Grant it in " +
                   "System Settings > Privacy & Security > Accessibility for DSH Desktop, then restart DSH Desktop."
        }
        if shotOk {
            return "Ready: accessibility and screen capture are both available."
        }
        if locked {
            return "Accessibility is ready, so reading app UI and performing UI actions work. " +
                   "Screenshots are unavailable because the screen is locked — macOS blocks capture of a locked session. " +
                   "Unlock the Mac to enable screenshots."
        }
        if activeDisplays == 0 {
            return "Accessibility is ready, so text-only operation works. Screenshots are unavailable because macOS " +
                   "reports no active display (displays asleep or the session inactive). Wake the display to enable screenshots."
        }
        return "Accessibility is ready, so text-only operation works. Screenshots need Screen Recording: " +
               "System Settings > Privacy & Security > Screen Recording, add and enable DSH Desktop."
    }()

    return strdup(jsonObject([
        ("ok", "true"),
        ("accessibility", trusted ? "true" : "false"),
        ("screenCapture", shotOk ? "true" : "false"),
        ("screenLocked", locked ? "true" : "false"),
        ("activeDisplays", String(activeDisplays)),
        ("screenCaptureDetail", jsonString(shotDetail)),
        ("runningApps", String(appCount)),
        ("guidance", jsonString(guidance)),
    ]))
}

@_cdecl("dsh_cua_free")
public func dsh_cua_free(_ ptr: UnsafeMutablePointer<CChar>?) {
    if let ptr = ptr { free(ptr) }
}