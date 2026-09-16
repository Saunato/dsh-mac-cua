// dsh-cua — AX action layer
//
// Actions resolve element indices against the most recent snapshot for the
// target app. Indices from a stale snapshot are rejected loudly rather than
// silently applied to whatever now occupies that position.

import Foundation
import AppKit
import ApplicationServices

// MARK: - Index resolution

enum IndexError: Error {
    case noSnapshot(String)
    case outOfRange(index: Int, count: Int)

    var message: String {
        switch self {
        case .noSnapshot(let app):
            return "No state snapshot for '\(app)'. Call get_app_state({\"app\": \"\(app)\"}) first — element indices only exist relative to a snapshot."
        case .outOfRange(let index, let count):
            return "element_index \(index) is out of range (last snapshot had \(count) elements). Call get_app_state again to re-derive indices; the UI changed since that index was published."
        }
    }
}

func resolveIndex(appKey: String, index: Int) throws -> AXUIElement {
    guard let snap = snapshotCache[appKey] else { throw IndexError.noSnapshot(appKey) }
    guard index >= 0 && index < snap.nodes.count else {
        throw IndexError.outOfRange(index: index, count: snap.nodes.count)
    }
    return snap.nodes[index]
}

func snapshotKey(_ app: NSRunningApplication) -> String {
    if let b = app.bundleIdentifier, !b.isEmpty { return b }
    if let n = app.localizedName, !n.isEmpty { return n }
    return "pid:\(app.processIdentifier)"
}

// MARK: - Click

/// Click an element. Preference order matches the reference behaviour: a real
/// accessibility action first, coordinates only as a fallback.
func performClick(app: NSRunningApplication, elementIndex: Int?, point: CGPoint?,
                  button: String, clickCount: Int) throws -> String {
    let appName = app.localizedName ?? snapshotKey(app)

    if let idx = elementIndex {
        let el = try resolveIndex(appKey: snapshotKey(app), index: idx)
        let role = shortRole(axRole(el))

        // 1. AXPress on the element itself.
        if let actions = axActionNames(el), actions.contains(kAXPressAction as String) {
            let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
            if err == .success { return "pressed \(role) at index \(idx)" }
        }

        // 2. AXPress on the nearest ancestor that supports it. Canvas-drawn rows
        //    routinely expose the action only on a container.
        if let ancestor = pressableAncestor(el, depth: 0) {
            let err = AXUIElementPerformAction(ancestor, kAXPressAction as CFString)
            if err == .success {
                let aRole = shortRole(axRole(ancestor))
                return "pressed ancestor \(aRole) for \(role) at index \(idx)"
            }
        }

        // 3. Fall back to the element's centre point.
        if let o = axOrigin(el), let s = axSize(el), s.width > 0, s.height > 0 {
            let centre = CGPoint(x: o.x + s.width / 2, y: o.y + s.height / 2)
            try postClick(at: centre, button: button, clickCount: clickCount)
            return "\(role) at index \(idx) exposes no AXPress; clicked its centre \(Int(centre.x)),\(Int(centre.y)) instead"
        }

        throw DshError.action("Element at index \(idx) (\(role)) has no AXPress action and no usable geometry for a coordinate click")
    }

    guard let pt = point else {
        throw DshError.action("click needs either element_index or x/y")
    }
    try postClick(at: pt, button: button, clickCount: clickCount)
    _ = appName
    return "clicked \(Int(pt.x)),\(Int(pt.y))"
}

private func pressableAncestor(_ el: AXUIElement, depth: Int) -> AXUIElement? {
    if depth > 6 { return nil }
    guard let parent = axAttr(el, kAXParentAttribute as String) else { return nil }
    let p = parent as! AXUIElement
    if let actions = axActionNames(p), actions.contains(kAXPressAction as String) { return p }
    return pressableAncestor(p, depth: depth + 1)
}

// MARK: - Value / text selection

func performSetValue(app: NSRunningApplication, elementIndex: Int, value: String) throws -> String {
    let el = try resolveIndex(appKey: snapshotKey(app), index: elementIndex)
    let role = shortRole(axRole(el))

    let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFTypeRef)
    if err == .success {
        let back = axValueString(el)
        if back == value { return "set \(role) at index \(elementIndex) to \"\(value)\"" }
        return "set \(role) at index \(elementIndex); read back \"\(back)\" (the app may transform its input)"
    }
    throw DshError.action("Could not set value on \(role) at index \(elementIndex) (AXError \(err.rawValue)). The element may be read-only.")
}

/// Select a substring inside an editable element, or place the caret relative to it.
func performSelectText(app: NSRunningApplication, elementIndex: Int, text: String,
                       prefix: String?, suffix: String?, selectionType: String) throws -> String {
    let el = try resolveIndex(appKey: snapshotKey(app), index: elementIndex)
    let full = axValueString(el)
    guard !full.isEmpty else {
        throw DshError.action("Element at index \(elementIndex) has no text to select from")
    }

    // Locate the match. prefix/suffix disambiguate repeated occurrences.
    var searchStart = full.startIndex
    var matchRange: Range<String.Index>?
    while let r = full.range(of: text, range: searchStart..<full.endIndex) {
        var ok = true
        if let p = prefix, !p.isEmpty {
            let before = full[full.startIndex..<r.lowerBound]
            if !before.hasSuffix(p) { ok = false }
        }
        if let s = suffix, !s.isEmpty {
            let after = full[r.upperBound..<full.endIndex]
            if !after.hasPrefix(s) { ok = false }
        }
        if ok { matchRange = r; break }
        searchStart = r.upperBound
        if searchStart >= full.endIndex { break }
    }
    guard let range = matchRange else {
        throw DshError.action("Text \"\(text)\" was not found in element at index \(elementIndex)\(prefix != nil ? " with the given prefix" : "")")
    }

    let ns = full as NSString
    let loc = full.distance(from: full.startIndex, to: range.lowerBound)
    let len = full.distance(from: range.lowerBound, to: range.upperBound)

    var cfRange: CFRange
    switch selectionType {
    case "cursor_before": cfRange = CFRange(location: loc, length: 0)
    case "cursor_after":  cfRange = CFRange(location: loc + len, length: 0)
    default:              cfRange = CFRange(location: loc, length: len)
    }
    _ = ns
    guard let axRange = AXValueCreate(.cfRange, &cfRange) else {
        throw DshError.action("Could not build a text range for selection")
    }
    let err = AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, axRange)
    if err == .success {
        return "selected \(selectionType) at offset \(cfRange.location) length \(cfRange.length) in element \(elementIndex)"
    }
    throw DshError.action("Could not set the selection (AXError \(err.rawValue))")
}

func performSecondaryAction(app: NSRunningApplication, elementIndex: Int, action: String) throws -> String {
    let el = try resolveIndex(appKey: snapshotKey(app), index: elementIndex)
    let available = axActionNames(el) ?? []
    guard available.contains(action) else {
        throw DshError.action("Element at index \(elementIndex) does not expose the action \"\(action)\". Available: \(available.isEmpty ? "(none)" : available.joined(separator: ", ")). Do not guess action names.")
    }
    let err = AXUIElementPerformAction(el, action as CFString)
    if err == .success { return "performed \(action) on index \(elementIndex)" }
    throw DshError.action("Action \(action) failed (AXError \(err.rawValue))")
}

// MARK: - Scroll

/// Scroll using the element's scrollbar when it has one, otherwise synthesize
/// wheel events at the element's location.
func performScroll(app: NSRunningApplication, elementIndex: Int?, point: CGPoint?,
                   direction: String, pages: Double) throws -> String {
    let appKey = snapshotKey(app)
    var target: CGPoint?
    var el: AXUIElement?

    if let idx = elementIndex {
        el = try resolveIndex(appKey: appKey, index: idx)
        if let o = axOrigin(el!), let s = axSize(el!) {
            target = CGPoint(x: o.x + s.width / 2, y: o.y + s.height / 2)
        }
    } else if let p = point {
        target = p
    }

    // Prefer an explicit scrollbar action when the element exposes one.
    if let e = el, let actions = axActionNames(e) {
        let want: String? = {
            switch direction {
            case "down", "d": return "AXScrollDownByPage"
            case "up", "u": return "AXScrollUpByPage"
            case "left", "l": return "AXScrollLeftByPage"
            case "right", "r": return "AXScrollRightByPage"
            default: return nil
            }
        }()
        if let w = want, actions.contains(w) {
            let err = AXUIElementPerformAction(e, w as CFString)
            if err == .success { return "scrolled \(direction) via \(w)" }
        }
    }

    guard let pt = target else {
        throw DshError.action("scroll needs element_index or x/y to know where to scroll")
    }
    let (dx, dy): (Int32, Int32) = {
        let unit = Int32(120 * max(1, pages))
        switch direction {
        case "down", "d": return (0, -unit)
        case "up", "u":   return (0, unit)
        case "left", "l": return (unit, 0)
        case "right", "r": return (-unit, 0)
        default:          return (0, -unit)
        }
    }()
    try postScroll(at: pt, dx: dx, dy: dy)
    return "scrolled \(direction) at \(Int(pt.x)),\(Int(pt.y))"
}

// MARK: - Focus

/// The element that currently owns keyboard focus in `app`, if any.
///
/// Used both to wait for focus to actually settle before synthesizing input and
/// to read back what an edit produced.
func focusedElement(of app: NSRunningApplication) -> AXUIElement? {
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    guard let v = axAttr(axApp, kAXFocusedUIElementAttribute as String) else { return nil }
    return (v as! AXUIElement)
}

/// Wait until `app` is frontmost and something inside it owns keyboard focus.
///
/// Synthesized key events go to the focused element, so typing before the target
/// is ready lands the characters in the wrong place — or nowhere. Returns the
/// number of milliseconds waited, or nil when focus never arrived.
func waitForFocus(_ app: NSRunningApplication, timeoutMs: Int = 2500) -> (focused: Bool, waitedMs: Int) {
    let step = 40
    var waited = 0
    while waited < timeoutMs {
        let frontmost = NSWorkspace.shared.frontmostApplication
        let isFront = frontmost?.processIdentifier == app.processIdentifier
        if isFront, focusedElement(of: app) != nil {
            return (true, waited)
        }
        usleep(useconds_t(step * 1000))
        waited += step
    }
    return (false, waited)
}

/// Read the value of the focused element, for verifying that an edit landed.
func focusedValue(of app: NSRunningApplication) -> String? {
    guard let el = focusedElement(of: app) else { return nil }
    let v = axValueString(el)
    return v
}

// MARK: - Errors

enum DshError: Error {
    case action(String)
    case notFound(String)
    case screenshot(String)

    var message: String {
        switch self {
        case .action(let m), .notFound(let m), .screenshot(let m): return m
        }
    }
}