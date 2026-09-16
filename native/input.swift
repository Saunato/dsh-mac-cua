// dsh-cua — input synthesis
//
// Keyboard and mouse events go through CGEvent. This is the same channel the
// reference implementation uses, and it is why `press_key`, `type_text` and
// coordinate clicks are gated behind the Accessibility permission.

import Foundation
import AppKit
import CoreGraphics
import Carbon.HIToolbox

// MARK: - Key name table
//
// Accepts xdotool-style names so key chords read the same way as the reference
// documentation: "a", "Return", "super+c", "Up", "KP_0".

private let keyNames: [String: CGKeyCode] = [
    // Letters
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
    "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
    "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
    "y": 16, "z": 6,
    // Digits
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21,
    "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
    // Symbols
    "minus": 27, "equal": 24, "bracketleft": 33, "bracketright": 30,
    "backslash": 42, "semicolon": 41, "apostrophe": 39, "grave": 50,
    "comma": 43, "period": 47, "slash": 44,
    // Whitespace / editing
    "space": 49, "Return": 36, "return": 36, "Enter": 36, "enter": 36,
    "Tab": 48, "tab": 48, "BackSpace": 51, "backspace": 51, "Delete": 117,
    "Escape": 53, "escape": 53, "Esc": 53, "esc": 53,
    // Navigation
    "Left": 123, "Right": 124, "Down": 125, "Up": 126,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "Home": 115, "End": 119, "Page_Up": 116, "Page_Down": 121,
    "Prior": 116, "Next": 121,
    // Function keys
    "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97,
    "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111,
    // Keypad
    "KP_0": 82, "KP_1": 83, "KP_2": 84, "KP_3": 85, "KP_4": 86,
    "KP_5": 87, "KP_6": 88, "KP_7": 89, "KP_8": 91, "KP_9": 92,
    "KP_Enter": 76, "KP_Decimal": 65, "KP_Add": 69, "KP_Subtract": 78,
    "KP_Multiply": 67, "KP_Divide": 75,
]

/// Modifier names, mapped to their keycodes. Aliases cover the common spellings.
private let modifierNames: [String: CGKeyCode] = [
    "super": 55, "cmd": 55, "command": 55, "meta": 55, "win": 55,
    "shift": 56,
    "ctrl": 59, "control": 59,
    "alt": 58, "option": 58, "opt": 58,
    "fn": 63,
]

func keyCode(for name: String) -> CGKeyCode? {
    if let k = keyNames[name] { return k }
    // Case-insensitive fallback for names like "return" / "RETURN".
    let lower = name.lowercased()
    if let entry = keyNames.first(where: { $0.key.lowercased() == lower }) { return entry.value }
    if let entry = modifierNames.first(where: { $0.key.lowercased() == lower }) { return entry.value }
    return nil
}

// MARK: - Keyboard

/// Press a `+`-separated chord, e.g. "a", "Return", "super+c", "super+shift+4".
func postKeyChord(_ chord: String) throws -> String {
    let parts = chord.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
    guard !parts.isEmpty else { throw DshError.action("Empty key chord") }

    var modifiers: [CGKeyCode] = []
    var mainKey: CGKeyCode?

    for part in parts {
        if let m = modifierNames[part.lowercased()], mainKey == nil {
            modifiers.append(m)
            continue
        }
        if let k = keyCode(for: part) {
            if mainKey == nil {
                mainKey = k
            } else {
                // Multiple non-modifier keys: treat trailing ones as a sequence.
                break
            }
        } else if let m = modifierNames[part.lowercased()] {
            modifiers.append(m)
        } else {
            throw DshError.action("Unknown key name \"\(part)\" in chord \"\(chord)\". Use xdotool-style names such as \"a\", \"Return\", \"Tab\", \"Up\", \"super+c\", \"KP_0\".")
        }
    }

    guard let key = mainKey else {
        // Modifier-only chord, e.g. "super" — tap it.
        if let m = modifiers.first {
            try tapKey(m)
            return "tapped modifier \(chord)"
        }
        throw DshError.action("Chord \"\(chord)\" has no key to press")
    }

    let source = CGEventSource(stateID: .hidSystemState)

    // Press modifiers down in order.
    for m in modifiers {
        if let e = CGEvent(keyboardEventSource: source, virtualKey: m, keyDown: true) {
            e.flags = currentFlags(modifiers)
            e.post(tap: .cghidEventTap)
        }
        usleep(8000)
    }

    // Main key down/up with modifier flags set so shifted characters resolve.
    if let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true) {
        down.flags = currentFlags(modifiers)
        down.post(tap: .cghidEventTap)
    }
    usleep(8000)
    if let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) {
        up.flags = currentFlags(modifiers)
        up.post(tap: .cghidEventTap)
    }
    usleep(8000)

    // Release modifiers in reverse order.
    for m in modifiers.reversed() {
        if let e = CGEvent(keyboardEventSource: source, virtualKey: m, keyDown: false) {
            e.flags = []
            e.post(tap: .cghidEventTap)
        }
        usleep(8000)
    }

    let modNames = parts.dropLast().joined(separator: "+")
    return modNames.isEmpty ? "pressed \(chord)" : "pressed \(chord)"
}

private func currentFlags(_ modifiers: [CGKeyCode]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for m in modifiers {
        switch m {
        case 55: flags.insert(.maskCommand)
        case 56: flags.insert(.maskShift)
        case 59: flags.insert(.maskControl)
        case 58: flags.insert(.maskAlternate)
        case 63: flags.insert(.maskSecondaryFn)
        default: break
        }
    }
    return flags
}

private func tapKey(_ code: CGKeyCode) throws {
    let source = CGEventSource(stateID: .hidSystemState)
    CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
    usleep(8000)
    CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
}

/// Type literal text by posting Unicode strings, which bypasses keyboard layout.
func postText(_ text: String) throws -> String {
    guard !text.isEmpty else { return "typed nothing" }
    let source = CGEventSource(stateID: .hidSystemState)
    let units = Array(text.utf16)
    let chunkSize = 20
    var index = 0

    // Note: "\n" and "\r" synthesize a real Return keypress. Many composers send
    // the message or submit the form on Return rather than inserting a newline —
    // the instruction document warns the model about this.
    while index < units.count {
        let end = min(index + chunkSize, units.count)
        let chunk = Array(units[index..<end])
        if let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true) {
            down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            down.post(tap: .cghidEventTap)
        }
        if let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) {
            up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            up.post(tap: .cghidEventTap)
        }
        index = end
        usleep(6000)
    }
    let shown = text.count > 60 ? String(text.prefix(60)) + "…" : text
    return "typed \(text.count) character(s): \"\(shown.replacingOccurrences(of: "\n", with: "\\n"))\""
}

// MARK: - Pasteboard

/// Write text to the pasteboard, press Cmd+V, then restore the previous contents.
/// Restoring matters: silently clobbering the user's clipboard is a visible bug.
func postPaste(_ text: String, format: String) throws -> String {
    let pb = NSPasteboard.general

    // Save every representation we are about to touch.
    let savedItems = pb.pasteboardItems?.map { item -> [NSPasteboard.PasteboardType: Data] in
        var copy: [NSPasteboard.PasteboardType: Data] = [:]
        for type in item.types {
            if let d = item.data(forType: type) { copy[type] = d }
        }
        return copy
    } ?? []

    pb.clearContents()

    var wrote = false
    switch format.lowercased() {
    case "html":
        if let data = text.data(using: .utf8) {
            pb.setData(data, forType: .html)
            pb.setString(text, forType: .string)
            wrote = true
        }
    case "md":
        // Plain-text paste with the markdown source intact is the least
        // surprising behaviour across apps; .string keeps newlines.
        pb.setString(text, forType: .string)
        wrote = true
    default:
        pb.setString(text, forType: .string)
        wrote = true
    }
    guard wrote else { throw DshError.action("Could not write to the pasteboard") }

    // Give the pasteboard a moment before the target app reads it.
    usleep(60_000)
    _ = try postKeyChord("super+v")
    // Let the paste land before we restore.
    usleep(220_000)

    // Restore the user's clipboard.
    pb.clearContents()
    if !savedItems.isEmpty {
        let items = savedItems.map { dict -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in dict { item.setData(data, forType: type) }
            return item
        }
        pb.writeObjects(items)
    }

    let shown = text.count > 60 ? String(text.prefix(60)) + "…" : text
    return "pasted as \(format) (\(text.count) chars, clipboard restored): \"\(shown)\""
}

// MARK: - Mouse

func postClick(at point: CGPoint, button: String, clickCount: Int) throws {
    let source = CGEventSource(stateID: .hidSystemState)
    let (downType, upType, cgButton): (CGEventType, CGEventType, CGMouseButton) = {
        switch button.lowercased() {
        case "right", "r":  return (.rightMouseDown, .rightMouseUp, .right)
        case "middle", "m": return (.otherMouseDown, .otherMouseUp, .center)
        default:            return (.leftMouseDown, .leftMouseUp, .left)
        }
    }()

    // Move first so hover state settles before the press.
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?
        .post(tap: .cghidEventTap)
    usleep(20_000)

    let count = max(1, clickCount)
    for n in 1...count {
        if let down = CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: point, mouseButton: cgButton) {
            down.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            down.post(tap: .cghidEventTap)
        }
        usleep(22_000)
        if let up = CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: point, mouseButton: cgButton) {
            up.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            up.post(tap: .cghidEventTap)
        }
        if n < count { usleep(45_000) }
    }
}

func postScroll(at point: CGPoint, dx: Int32, dy: Int32) throws {
    let source = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?
        .post(tap: .cghidEventTap)
    usleep(15_000)
    if let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
        e.location = point
        e.post(tap: .cghidEventTap)
    }
    usleep(60_000)
}

/// Drag along a path, posting intermediate moves so apps that track motion
/// (selection, sliders, canvas tools) see a real gesture.
func postDrag(from: CGPoint, to: CGPoint) throws {
    let source = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left)?
        .post(tap: .cghidEventTap)
    usleep(40_000)
    if let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left) {
        down.post(tap: .cghidEventTap)
    }
    usleep(60_000)

    let steps = 14
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        if let move = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left) {
            move.post(tap: .cghidEventTap)
        }
        usleep(16_000)
    }

    if let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left) {
        up.post(tap: .cghidEventTap)
    }
    usleep(40_000)
}