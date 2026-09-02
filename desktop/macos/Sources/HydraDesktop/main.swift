import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, HydraWindowControllerDelegate {
    private let backend = BackendController()
    private var windows: [HydraWindowController] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        backend.start { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.openWindow(kind: .full)
            case .failure(let error):
                self.presentFatalError(error)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    @objc private func newFullWindow() {
        openWindow(kind: .full)
    }

    @objc private func newProjectDirectoryWindow() {
        openWindow(kind: .projectDirectory)
    }

    private func openWindow(kind: HydraWindowKind, projectID: String? = nil, agentID: String? = nil) {
        guard let baseURL = backend.baseURL else { return }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let controller = HydraWindowController(
            kind: kind,
            baseURL: baseURL,
            defaultProjectID: projectID ?? backend.status?.defaultProjectId,
            defaultAgentID: agentID,
            bootstrapToken: backend.takeBootstrapToken(),
            configuration: configuration,
            desktopDelegate: self
        )
        controller.window?.delegate = self
        windows.append(controller)
        controller.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func desktopWindowRequested(_ kind: HydraWindowKind, projectID: String?, agentID: String?) {
        openWindow(kind: kind, projectID: projectID, agentID: agentID)
    }

    func desktopWindowActivatedProject(_ projectID: String) {
        UserDefaults.standard.set(projectID, forKey: "HydraLastProjectID")
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        windows.first(where: { $0.window === window })?.prepareForClose()
        windows.removeAll { $0.window === window }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard windows.first(where: { $0.window === sender })?.activeTurn == true else { return true }
        let alert = NSAlert()
        alert.messageText = "Close this window?"
        alert.informativeText = "This agent is still working. Stop Session retains its head, worktree, branch and conversation. Opening the head later resumes it automatically."
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Close and Keep Running")
        alert.addButton(withTitle: "Stop Session and Close")
        let answer = alert.runModal()
        if answer == .alertThirdButtonReturn {
            windows.first(where: { $0.window === sender })?.requestStopAndClose()
            return false
        }
        return answer == .alertSecondButtonReturn
    }

    private func buildMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Hydra", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Hydra", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem()
        mainMenu.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        let full = fileMenu.addItem(withTitle: "New Hydra Window", action: #selector(newFullWindow), keyEquivalent: "n")
        full.target = self
        let projectDirectory = fileMenu.addItem(withTitle: "New Project Chat", action: #selector(newProjectDirectoryWindow), keyEquivalent: "n")
        projectDirectory.keyEquivalentModifierMask = [.command, .shift]
        projectDirectory.target = self
        fileItem.submenu = fileMenu

        NSApp.mainMenu = mainMenu
    }

    private func presentFatalError(_ error: Error) {
        let alert = NSAlert(error: error)
        alert.runModal()
        NSApp.terminate(nil)
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
