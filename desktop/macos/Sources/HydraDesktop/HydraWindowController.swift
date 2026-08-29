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

private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?

    init(delegate: WKScriptMessageHandler) {
        self.delegate = delegate
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.userContentController(userContentController, didReceive: message)
    }
}

final class HydraWindowController: NSWindowController, WKNavigationDelegate, WKScriptMessageHandler {
    private let baseURL: URL
    private let webView: WKWebView
    private weak var desktopDelegate: HydraWindowControllerDelegate?
    private var messageHandler: WeakScriptMessageHandler?
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
        let messageHandler = WeakScriptMessageHandler(delegate: self)
        self.messageHandler = messageHandler
        configuration.userContentController.add(messageHandler, name: "hydra")
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

    func prepareForClose() {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "hydra")
        messageHandler = nil
        webView.navigationDelegate = nil
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
            if body["force"] as? Bool == true { activeTurn = false }
            window?.performClose(nil)
        default:
            break
        }
    }

    func requestStopAndClose() {
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('hydra-desktop-command',{detail:{type:'stop-and-close'}}))")
    }

    private func effectivePort(_ url: URL) -> Int? {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }

    private func isHydraOrigin(_ url: URL) -> Bool {
        url.scheme?.caseInsensitiveCompare(baseURL.scheme ?? "") == .orderedSame &&
            url.host?.caseInsensitiveCompare(baseURL.host ?? "") == .orderedSame &&
            effectivePort(url) == effectivePort(baseURL)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if !isHydraOrigin(url) {
            if url.scheme?.lowercased() == "http" || url.scheme?.lowercased() == "https" {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}
