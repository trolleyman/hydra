import AppKit
import WebKit

enum HydraWindowKind {
    case full
    case focused
}

protocol HydraWindowControllerDelegate: AnyObject {
    func desktopWindowRequested(_ kind: HydraWindowKind, projectID: String?)
    func desktopWindowActivatedProject(_ projectID: String)
}

final class HydraWindowController: NSWindowController, WKNavigationDelegate, WKScriptMessageHandler {
    private let baseURL: URL
    private let webView: WKWebView
    private weak var desktopDelegate: HydraWindowControllerDelegate?
    private(set) var activeTurn = false

    init(kind: HydraWindowKind, baseURL: URL, defaultProjectID: String?, bootstrapToken: String?, configuration: WKWebViewConfiguration, desktopDelegate: HydraWindowControllerDelegate) {
        self.baseURL = baseURL
        self.desktopDelegate = desktopDelegate
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
        configuration.userContentController.add(self, name: "hydra")
        webView.navigationDelegate = self
        webView.allowsMagnification = true

        let path: String
        if kind == .focused, let defaultProjectID {
            let encoded = defaultProjectID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? defaultProjectID
            path = "/focused/\(encoded)"
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

    deinit {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "hydra")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "hydra", let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        let projectID = body["projectId"] as? String
        switch type {
        case "new-full-window":
            desktopDelegate?.desktopWindowRequested(.full, projectID: nil)
        case "new-focused-window":
            desktopDelegate?.desktopWindowRequested(.focused, projectID: projectID)
        case "active-project":
            if let projectID { desktopDelegate?.desktopWindowActivatedProject(projectID) }
        case "window-state":
            activeTurn = body["activeTurn"] as? Bool ?? false
        case "close-window":
            window?.performClose(nil)
        default:
            break
        }
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
