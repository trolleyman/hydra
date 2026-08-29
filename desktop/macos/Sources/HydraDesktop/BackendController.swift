import Foundation

struct BackendStatus: Decodable {
    let version: String?
    let projectRoot: String?
    let defaultProjectId: String?
    let desktopProtocol: Int?
    let buildId: String?

    enum CodingKeys: String, CodingKey {
        case version
        case projectRoot = "project_root"
        case defaultProjectId = "default_project_id"
        case desktopProtocol = "desktop_protocol"
        case buildId = "build_id"
    }
}

private struct ReadyRecord: Decodable {
    let protocolVersion: Int
    let url: URL
    let pid: Int
    let bootstrapToken: String
    let version: String?
    let projectRoot: String?
    let defaultProjectId: String?
    let buildId: String?

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case url
        case pid
        case bootstrapToken = "bootstrap_token"
        case version
        case projectRoot = "project_root"
        case defaultProjectId = "default_project_id"
        case buildId = "build_id"
    }
}

private struct DesktopConnectRecord: Decodable {
    let protocolVersion: Int
    let url: URL
    let bootstrapToken: String
    let version: String?
    let projectRoot: String?
    let defaultProjectId: String?
    let buildId: String?
    let selectedProjectId: String?

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case url
        case bootstrapToken = "bootstrap_token"
        case version
        case projectRoot = "project_root"
        case defaultProjectId = "default_project_id"
        case buildId = "build_id"
        case selectedProjectId = "selected_project_id"
    }
}

private struct DesktopActiveRecord: Decodable {
    let active: Bool
}

enum BackendError: LocalizedError {
    case bundledBinaryMissing
    case launchFailed(String)
    case readinessTimedOut(String)
    case incompatibleProtocol(Int)
    case invalidResponse
    case desktopConnectUnavailable

    var errorDescription: String? {
        switch self {
        case .bundledBinaryMissing:
            return "HydraBackend is missing from the app bundle."
        case .launchFailed(let detail):
            return "The Hydra backend could not be launched: \(detail)"
        case .readinessTimedOut(let logPath):
            return "The Hydra backend did not become ready. See \(logPath)."
        case .incompatibleProtocol(let version):
            return "The bundled backend uses unsupported desktop protocol \(version)."
        case .invalidResponse:
            return "The Hydra backend returned an invalid status response."
        case .desktopConnectUnavailable:
            return "The bundled backend predates shared desktop connection support."
        }
    }
}

final class BackendController {
    static let supportedDesktopProtocol = 3

    private(set) var baseURL: URL?
    private(set) var status: BackendStatus?
    private(set) var ownsProcess = false
    private var bootstrapToken: String?

    private var process: Process?
    private var logHandle: FileHandle?
    private var readyFile: URL?
    private var selectedProjectRoot: URL?

    func takeBootstrapToken() -> String? {
        defer { bootstrapToken = nil }
        return bootstrapToken
    }

    func start(projectRoot: @escaping () -> URL?, completion: @escaping (Result<BackendStatus, Error>) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let selectedRoot = projectRoot() else {
                completion(.failure(BackendError.launchFailed("no project was selected")))
                return
            }
            self.selectedProjectRoot = selectedRoot
            self.connectThroughBundledCLI(projectRoot: selectedRoot) { result in
                switch result {
                case .success:
                    completion(result)
                case .failure(.desktopConnectUnavailable):
                    // Development bundles predating the shared control command
                    // still use the private ready-file launch path.
                    self.launchBundledBackend(projectRoot: selectedRoot, completion: completion)
                case .failure(let error):
                    completion(.failure(error))
                }
            }
        }
    }

    private func connectThroughBundledCLI(projectRoot: URL, completion: @escaping (Result<BackendStatus, Error>) -> Void) {
        let binary = ProcessInfo.processInfo.environment["HYDRA_DESKTOP_BACKEND"].map(URL.init(fileURLWithPath:))
            ?? Bundle.main.resourceURL?.appendingPathComponent("HydraBackend")
        guard let binary, FileManager.default.isExecutableFile(atPath: binary.path) else {
            completion(.failure(BackendError.bundledBinaryMissing))
            return
        }
        let output = Pipe()
        let errors = Pipe()
        let process = Process()
        process.executableURL = binary
        process.arguments = ["__desktop-connect", "--project", projectRoot.path]
        process.standardOutput = output
        process.standardError = errors
        process.terminationHandler = { [weak self] task in
            guard let self else { return }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            if task.terminationStatus != 0 {
                let detail = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                let error: BackendError = detail.contains("unknown command") && detail.contains("__desktop-connect")
                    ? .desktopConnectUnavailable
                    : .launchFailed(detail.trimmingCharacters(in: .whitespacesAndNewlines))
                DispatchQueue.main.async { completion(.failure(error)) }
                return
            }
            guard
                  let record = try? JSONDecoder().decode(DesktopConnectRecord.self, from: data),
                  record.protocolVersion == Self.supportedDesktopProtocol,
                  record.url.host == "127.0.0.1" || record.url.host == "localhost" || record.url.host == "::1" else {
                DispatchQueue.main.async { completion(.failure(BackendError.invalidResponse)) }
                return
            }
            let status = BackendStatus(
                version: record.version,
                projectRoot: record.projectRoot,
                defaultProjectId: record.selectedProjectId ?? record.defaultProjectId,
                desktopProtocol: record.protocolVersion,
                buildId: record.buildId
            )
            self.baseURL = record.url
            self.status = status
            self.bootstrapToken = record.bootstrapToken
            DispatchQueue.main.async { completion(.success(status)) }
        }
        do {
            try process.run()
        } catch {
            completion(.failure(BackendError.launchFailed(error.localizedDescription)))
        }
    }

    func stopOwnedBackend() {
        guard ownsProcess, let process, process.isRunning else { return }
        process.terminate()
        self.process = nil
        ownsProcess = false
        try? logHandle?.close()
        logHandle = nil
        if let readyFile {
            try? FileManager.default.removeItem(at: readyFile)
        }
    }

    func hasActiveSessions(completion: @escaping (Bool) -> Void) {
        guard let projectRoot = selectedProjectRoot else {
            completion(false)
            return
        }
        let binary = ProcessInfo.processInfo.environment["HYDRA_DESKTOP_BACKEND"].map(URL.init(fileURLWithPath:))
            ?? Bundle.main.resourceURL?.appendingPathComponent("HydraBackend")
        guard let binary else {
            completion(true)
            return
        }
        let output = Pipe()
        let process = Process()
        process.executableURL = binary
        process.arguments = ["__desktop-active", "--project", projectRoot.path]
        process.standardOutput = output
        process.standardError = Pipe()
        process.terminationHandler = { task in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            let record = try? JSONDecoder().decode(DesktopActiveRecord.self, from: data)
            DispatchQueue.main.async { completion(task.terminationStatus == 0 ? record?.active ?? true : true) }
        }
        do {
            try process.run()
        } catch {
            completion(true)
        }
    }

    private func launchBundledBackend(projectRoot: URL, completion: @escaping (Result<BackendStatus, Error>) -> Void) {
        let binary = ProcessInfo.processInfo.environment["HYDRA_DESKTOP_BACKEND"].map(URL.init(fileURLWithPath:))
            ?? Bundle.main.resourceURL?.appendingPathComponent("HydraBackend")
        guard let binary, FileManager.default.isExecutableFile(atPath: binary.path) else {
            DispatchQueue.main.async { completion(.failure(BackendError.bundledBinaryMissing)) }
            return
        }

        do {
            let support = try applicationSupportDirectory()
            let runtime = support.appendingPathComponent("runtime", isDirectory: true)
            let logs = support.appendingPathComponent("logs", isDirectory: true)
            try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
            let ready = runtime.appendingPathComponent("ready-\(UUID().uuidString).json")
            let log = logs.appendingPathComponent("backend.log")
            FileManager.default.createFile(atPath: log.path, contents: nil)
            let handle = try FileHandle(forWritingTo: log)
            try handle.seekToEnd()

            let process = Process()
            process.executableURL = binary
            process.arguments = ["server"]
            process.currentDirectoryURL = projectRoot
            var environment = ProcessInfo.processInfo.environment
            environment["HYDRA_API_ADDR"] = "127.0.0.1:0"
            environment["HYDRA_DESKTOP_READY_FILE"] = ready.path
            process.environment = environment
            process.standardOutput = handle
            process.standardError = handle
            process.terminationHandler = { [weak self] task in
                guard let self, self.ownsProcess, task.terminationStatus != 0 else { return }
                DispatchQueue.main.async {
                    NotificationCenter.default.post(
                        name: .hydraBackendExited,
                        object: self,
                        userInfo: ["status": task.terminationStatus, "log": log.path]
                    )
                }
            }
            try process.run()
            self.process = process
            self.logHandle = handle
            self.readyFile = ready
            self.ownsProcess = true
            waitForReadiness(readyFile: ready, logFile: log, completion: completion)
        } catch {
            DispatchQueue.main.async { completion(.failure(BackendError.launchFailed(error.localizedDescription))) }
        }
    }

    private func waitForReadiness(readyFile: URL, logFile: URL, completion: @escaping (Result<BackendStatus, Error>) -> Void) {
        let deadline = Date().addingTimeInterval(20)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            while Date() < deadline {
                if let data = try? Data(contentsOf: readyFile),
                   let record = try? JSONDecoder().decode(ReadyRecord.self, from: data) {
                    guard record.protocolVersion == Self.supportedDesktopProtocol else {
                        DispatchQueue.main.async { completion(.failure(BackendError.incompatibleProtocol(record.protocolVersion))) }
                        return
                    }
                    guard record.url.host == "127.0.0.1" || record.url.host == "localhost" || record.url.host == "::1" else {
                        DispatchQueue.main.async { completion(.failure(BackendError.invalidResponse)) }
                        return
                    }
                    let status = BackendStatus(
                        version: record.version,
                        projectRoot: record.projectRoot,
                        defaultProjectId: record.defaultProjectId,
                        desktopProtocol: record.protocolVersion,
                        buildId: record.buildId
                    )
                    self.baseURL = record.url
                    self.status = status
                    self.bootstrapToken = record.bootstrapToken
                    DispatchQueue.main.async { completion(.success(status)) }
                    return
                }
                if self.process?.isRunning == false { break }
                Thread.sleep(forTimeInterval: 0.05)
            }
            DispatchQueue.main.async { completion(.failure(BackendError.readinessTimedOut(logFile.path))) }
        }
    }

    private func applicationSupportDirectory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return base.appendingPathComponent("Hydra", isDirectory: true)
    }
}


extension Notification.Name {
    static let hydraBackendExited = Notification.Name("HydraBackendExited")
}
