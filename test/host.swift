// dsh-cua test host
//
// A deliberately small AppKit application used as the target for the native
// module's tests. It exists so that write actions (set_value, select_text,
// typing, clicking) can be exercised without touching any real application or
// the user's data.
//
// It prints "HOST_READY <pid>" on stdout once its window is up, which the test
// runner waits for before probing it.
//
// The text view is the important part: NSTextView implements the accessibility
// text interfaces (AXValue, AXSelectedTextRange, AXSelectedText) that
// select_text depends on, whereas NSTextField does not. Without it, selection
// could only be tested against a real editor.

import Foundation
import AppKit

final class TestHostDelegate: NSObject, NSApplicationDelegate, NSTextViewDelegate {
    var window: NSWindow!
    var textField: NSTextField!
    var textView: NSTextView!
    var button: NSButton!
    var label: NSTextField!
    var selectionLabel: NSTextField!
    var clickCount = 0

    /// The text the view starts with, so tests can assert on known offsets.
    ///
    /// "alpha" appears twice on purpose: select_text's prefix/suffix arguments
    /// exist to disambiguate a repeated match, and a seed with no repetition
    /// cannot exercise them.
    let seedText = "alpha bravo charlie delta alpha echo"

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(
            contentRect: NSRect(x: 320, y: 260, width: 520, height: 400),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "dsh-cua Test Host"

        let content = NSView(frame: window.contentView!.bounds)

        // ─ single-line field: set_value, type_text, paste ──────────────────
        textField = NSTextField(frame: NSRect(x: 24, y: 328, width: 472, height: 28))
        textField.placeholderString = "type here"
        textField.identifier = NSUserInterfaceItemIdentifier("probeField")
        textField.stringValue = ""

        // ── multi-line text view: select_text ──────────────────────────────
        let scroll = NSScrollView(frame: NSRect(x: 24, y: 200, width: 472, height: 110))
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        textView = NSTextView(frame: scroll.bounds)
        textView.string = seedText
        textView.isEditable = true
        textView.isSelectable = true
        textView.delegate = self
        textView.identifier = NSUserInterfaceItemIdentifier("probeTextView")
        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        scroll.documentView = textView

        // ── controls ───────────────────────────────────────────────────────
        button = NSButton(frame: NSRect(x: 24, y: 156, width: 150, height: 32))
        button.title = "ProbeButton"
        button.bezelStyle = .rounded
        button.identifier = NSUserInterfaceItemIdentifier("probeButton")
        button.target = self
        button.action = #selector(buttonPressed)

        label = NSTextField(labelWithString: "clicks: 0")
        label.frame = NSRect(x: 24, y: 124, width: 472, height: 22)
        label.identifier = NSUserInterfaceItemIdentifier("probeLabel")

        selectionLabel = NSTextField(labelWithString: "selection: none")
        selectionLabel.frame = NSRect(x: 24, y: 96, width: 472, height: 22)
        selectionLabel.identifier = NSUserInterfaceItemIdentifier("probeSelection")

        content.addSubview(textField)
        content.addSubview(scroll)
        content.addSubview(button)
        content.addSubview(label)
        content.addSubview(selectionLabel)
        window.contentView = content
        window.makeKeyAndOrderFront(nil)

        NSApp.activate(ignoringOtherApps: true)

        // Report the initial selection too, so a test can tell "selection
        // changed" from "selection was always this".
        textViewDidChangeSelection(Notification(name: NSTextView.didChangeSelectionNotification, object: textView))

        print("HOST_READY \(ProcessInfo.processInfo.processIdentifier)")
        fflush(stdout)
    }

    @objc func buttonPressed() {
        clickCount += 1
        label.stringValue = "clicks: \(clickCount)"
    }

    /// Mirror the current selection into a label the accessibility tree exposes,
    /// so a selection made through AX is observable the same way a click is.
    func textViewDidChangeSelection(_ notification: Notification) {
        let range = textView.selectedRange()
        let selected = range.length > 0
            ? (textView.string as NSString).substring(with: range)
            : ""
        selectionLabel.stringValue = "selection: loc=\(range.location) len=\(range.length) text=\(selected)"
    }
}

let app = NSApplication.shared
let delegate = TestHostDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()