import AppKit
import WebKit

enum HydraWindowKind {
    case full
    case focused
}

final class HydraWindowController: NSWindowController, WKNavigationDelegate {
    private let baseURL: URL
    private let webView: WKWebView

    init(kind: HydraWindowKind, baseURL: URL, defaultProjectID: String?, bootstrapToken: String?, configuration: WKWebViewConfiguration) {
        self.baseURL = baseURL
        self.webView = WKWebView(frame: .zero, configuration: configuration)
        let size = kind == .full ? NSSize(width: 1380, height: 900) : NSSize(width: 940, height: 780)
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.center()
        window.title = kind == .full ? "Hydra" : "Hydra - Focused chat"
        window.tabbingMode = .preferred
        window.contentView = webView
        super.init(window: window)
        webView.navigationDelegate = self
        webView.allowsMagnification = true

        let path: String
        if kind == .focused, let defaultProjectID {
            let encoded = defaultProjectID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? defaultProjectID
            path = "/project/\(encoded)/?new_focused=1"
        } else {
            path = "/"
        }
        var target = URLComponents(url: URL(string: path, relativeTo: baseURL)!, resolvingAgainstBaseURL: true)!
        if let bootstrapToken {
            target.fragment = "desktop-bootstrap=" + bootstrapToken
        }
        webView.load(URLRequest(url: target.url!))
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if navigationAction.navigationType == .linkActivated, url.host != baseURL.host {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}
