// dsh-cua — macOS Accessibility core
//
// Walks the AX tree of a target application, assigns element indices, renders a
// text representation the model can reason about, and performs AX actions.
//
// All access goes through the public Accessibility API (AXUIElement). Nothing
// here uses AppleScript, JXA or System Events — by design, matching the approach
// the reference implementation takes.

import Foundation
import AppKit
import ApplicationServices

// MARK: - Limits

private let MAX_NODES = 3000
private let MAX_DEPTH = 60

// MARK: - Snapshot cache
//
// Element indices are only meaningful against the snapshot that produced them.
// Each `get_app_state` publishes a fresh map, which is what makes
// "re-read state after acting" a hard requirement rather than a suggestion.

final class AppSnapshot {
    let appKey: String
    var nodes: [AXUIElement] = []
    var lines: [String] = []
    var elementCount: Int { nodes.count }

    init(appKey: String) {
        self.appKey = appKey
    }
}

var snapshotCache: [String: AppSnapshot] = [:]

// MARK: - Attribute helpers

func axAttr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, name as CFString, &value)
    return err == .success ? value : nil
}

func axString(_ el: AXUIElement, _ name: String) -> String {
    guard let v = axAttr(el, name) else { return "" }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    guard let v = axAttr(el, kAXChildrenAttribute as String) as? [AXUIElement] else { return [] }
    return v
}

func axRole(_ el: AXUIElement) -> String {
    return axString(el, kAXRoleAttribute as String)
}

func axSubrole(_ el: AXUIElement) -> String {
    return axString(el, kAXSubroleAttribute as String)
}

/// Strip the "AX" prefix so the rendered tree reads like the reference format.
func shortRole(_ role: String) -> String {
    return role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
}

func axOrigin(_ el: AXUIElement) -> CGPoint? {
    guard let v = axAttr(el, kAXPositionAttribute as String) else { return nil }
    var p = CGPoint.zero
    if AXValueGetValue(v as! AXValue, .cgPoint, &p) { return p }
    return nil
}

func axSize(_ el: AXUIElement) -> CGSize? {
    guard let v = axAttr(el, kAXSizeAttribute as String) else { return nil }
    var s = CGSize.zero
    if AXValueGetValue(v as! AXValue, .cgSize, &s) { return s }
    return nil
}

// MARK: - App resolution

/// Resolve an app reference (display name, bundle id, or path) to a running app,
/// launching it in the background when it is not running.
///
/// Preference order matters: helper and service processes frequently carry a
/// display name derived from the app they serve (for example "Open and Save
/// Panel Service (WeChat)"), so a plain name search would otherwise resolve to
/// the wrong process. Real application bundles win.
func resolveApp(_ raw: String) -> NSRunningApplication? {
    let apps = NSWorkspace.shared.runningApplications
        .filter { isLaunchableApp(bundleId: $0.bundleIdentifier ?? "", bundlePath: $0.bundleURL?.path) }

    // Exact bundle id
    if let a = apps.first(where: { $0.bundleIdentifier == raw }) { return a }
    // Exact display name
    if let a = apps.first(where: { $0.localizedName == raw }) { return a }
    // Case-insensitive display name
    if let a = apps.first(where: { ($0.localizedName ?? "").lowercased() == raw.lowercased() }) { return a }
    // Bundle id suffix, e.g. "Chrome" matching "com.google.Chrome"
    if let a = apps.first(where: { ($0.bundleIdentifier ?? "").lowercased().hasSuffix("." + raw.lowercased()) }) { return a }
    // Display name contains, preferring the shortest match so "WeChat" wins over
    // a longer helper name that happens to contain the same substring.
    let contains = apps
        .filter { ($0.localizedName ?? "").lowercased().contains(raw.lowercased()) }
        .sorted { ($0.localizedName ?? "").count < ($1.localizedName ?? "").count }
    if let a = contains.first { return a }

    // Not running — try to launch it by name.
    if let launched = launchAndWait(name: raw) { return launched }
    return nil
}

func launchAndWait(name: String) -> NSRunningApplication? {
    let ws = NSWorkspace.shared
    // Look up by full path first, then by using the app name as a search term.
    let candidates = ["/Applications/\(name).app", "/System/Applications/\(name).app"]
    for path in candidates {
        if FileManager.default.fileExists(atPath: path) {
            let url = URL(fileURLWithPath: path)
            if let app = ws.runningApplications.first(where: { $0.bundleURL?.path == path }) { return app }
            let sem = DispatchSemaphore(value: 0)
            var result: NSRunningApplication?
            ws.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { app, _ in
                result = app
                sem.signal()
            }
            _ = sem.wait(timeout: .now() + 8)
            if let r = result { return r }
        }
    }
    return nil
}

// MARK: - Tree walking

struct WalkResult {
    var nodes: [AXUIElement] = []
    var lines: [String] = []
    var truncated = false
}

/// Walk the window's accessibility tree depth-first, assigning a stable index to
/// every node in visit order. This ordering *is* the `element_index` contract.
///
/// The window itself is index 0, so window-level actions stay addressable.
func walkWindow(_ root: AXUIElement) -> WalkResult {
    var result = WalkResult()

    // Depth-first, pre-order, so parents always precede children.
    func visit(_ el: AXUIElement, _ depth: Int) {
        if result.nodes.count >= MAX_NODES { result.truncated = true; return }
        if depth > MAX_DEPTH { result.truncated = true; return }

        result.nodes.append(el)
        result.lines.append(renderNode(el, index: result.nodes.count - 1, depth: depth))

        for child in axChildren(el) {
            if result.nodes.count >= MAX_NODES { result.truncated = true; return }
            visit(child, depth + 1)
        }
    }

    visit(root, 0)
    return result
}

/// Render one node as a single line, the way the model will read it.
func renderNode(_ el: AXUIElement, index: Int, depth: Int) -> String {
    let role = shortRole(axRole(el))
    var parts: [String] = ["[\(index)]", String(repeating: "  ", count: min(depth, 12)) + role]

    let title = axString(el, kAXTitleAttribute as String)
    let desc = axString(el, kAXDescriptionAttribute as String)
    let value = axValueString(el)

    if !title.isEmpty { parts.append("title=\(sanitize(title))") }
    if !desc.isEmpty && desc != title { parts.append("desc=\(sanitize(desc))") }
    if !value.isEmpty && value != title { parts.append("value=\(sanitize(value))") }

    // Only surface actions that are not implied by the role, to keep lines short.
    if let actions = axActionNames(el), !actions.isEmpty {
        let notable = actions.filter { $0 != kAXPressAction as String }
        if !notable.isEmpty { parts.append("actions=\(notable.joined(separator: ","))") }
    }

    if let sub = axSubrole(el) as String?, !sub.isEmpty {
        parts.append("sub=\(shortRole(sub))")
    }

    // Coordinates are only useful as a fallback path, but the model needs them
    // when AX actions are unavailable.
    if let o = axOrigin(el), let s = axSize(el), s.width > 0, s.height > 0 {
        parts.append("@\(Int(o.x)),\(Int(o.y)) \(Int(s.width))x\(Int(s.height))")
    }

    return parts.joined(separator: " ")
}

func axValueString(_ el: AXUIElement) -> String {
    guard let v = axAttr(el, kAXValueAttribute as String) else { return "" }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    // Text areas report a range rather than a value.
    if CFGetTypeID(v) == AXValueGetTypeID() { return "" }
    return ""
}

func axActionNames(_ el: AXUIElement) -> [String]? {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success else { return nil }
    return names as? [String]
}

func sanitize(_ s: String) -> String {
    var out = s.replacingOccurrences(of: "\n", with: "\\n")
    out = out.replacingOccurrences(of: "\r", with: "\\r")
    out = out.replacingOccurrences(of: "\t", with: " ")
    if out.count > 160 { out = String(out.prefix(160)) + "…" }
    return "\"\(out)\""
}

// MARK: - Diff
//
// The model re-reads state after every action, so returning the entire tree each
// time is the dominant token cost. We return only the changed region plus enough
// context to keep indices trustworthy.

func diffLines(_ previous: [String], _ current: [String]) -> (String, Bool) {
    if previous.isEmpty || previous.count != current.count {
        return (current.joined(separator: "\n"), true)
    }
    var changed: [Int] = []
    for i in 0..<current.count where previous[i] != current[i] {
        changed.append(i)
    }
    if changed.isEmpty {
        return ("(no change)", false)
    }

    // Include one line of context on each side of every change so the model can
    // anchor the new indices.
    var keep = Set<Int>()
    for i in changed {
        keep.insert(i)
        if i > 0 { keep.insert(i - 1) }
        if i + 1 < current.count { keep.insert(i + 1) }
    }
    let maxKeep = 400
    if keep.count > maxKeep {
        // Too much churn to be worth diffing — send the full tree instead.
        return (current.joined(separator: "\n"), true)
    }

    var out: [String] = []
    var lastEmitted = -2
    for i in keep.sorted() {
        if i != lastEmitted + 1 && !out.isEmpty { out.append("  …") }
        let marker = changed.contains(i) ? "~" : " "
        out.append("\(marker) \(current[i])")
        lastEmitted = i
    }
    return (out.joined(separator: "\n"), false)
}