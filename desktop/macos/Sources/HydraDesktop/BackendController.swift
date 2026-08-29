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

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case url
        case pid
        case bootstrapToken = "bootstrap_token"
    }
}

enum BackendError: LocalizedError {
    case bundledBinaryMissing
    case launchFailed(String)
    case readinessTimedOut(String)
    case incompatibleProtocol(Int)
    case incompatibleVersion(String)
    case serverRefused(Int)
    case invalidResponse

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
        case .incompatibleVersion(let version):
            return "A Hydra server is already running, but version \(version) is incompatible with this app."
        case .serverRefused(let status):
            return "A server is already running on Hydra's default address but refused the app (HTTP \(status)). Stop it or adjust its local authentication settings."
        case .invalidResponse:
            return "The Hydra backend returned an invalid status response."
        }
    }
}

final class BackendController {
    static let supportedDesktopProtocol = 2
    static let supportedServerVersion = "0.1.0"

    private(set) var baseURL: URL?
    private(set) var status: BackendStatus?
    private(set) var ownsProcess = false
    private var bootstrapToken: String?

    private var process: Process?
    private var logHandle: FileHandle?
    private var readyFile: URL?

    func takeBootstrapToken() -> String? {
        defer { bootstrapToken = nil }
        return bootstrapToken
    }

    func start(projectRoot: @escaping () -> URL?, completion: @escaping (Result<BackendStatus, Error>) -> Void) {
        let defaultURL = URL(string: "http://127.0.0.1:26600")!
        fetchStatus(at: defaultURL) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let status):
                guard status.version == Self.supportedServerVersion else {
                    DispatchQueue.main.async {
                        completion(.failure(BackendError.incompatibleVersion(status.version ?? "unknown")))
                    }
                    return
                }
                self.baseURL = defaultURL
                self.status = status
                DispatchQueue.main.async { completion(.success(status)) }
            case .failure(let error):
                if let backendError = error as? BackendError, case .serverRefused = backendError {
                    DispatchQueue.main.async { completion(.failure(error)) }
                    return
                }
                DispatchQueue.main.async {
                    guard let selectedRoot = projectRoot() else {
                        completion(.failure(BackendError.launchFailed("no project was selected")))
                        return
                    }
                    self.launchBundledBackend(projectRoot: selectedRoot, completion: completion)
                }
            }
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
        guard let baseURL else {
            completion(false)
            return
        }
        fetchJSON(path: "/api/projects", at: baseURL) { (projects: Result<[[String: JSONValue]], Error>) in
            guard case .success(let values) = projects else {
                completion(true)
                return
            }
            let ids = values.compactMap { $0["id"]?.string }
            if ids.isEmpty {
                completion(false)
                return
            }
            let group = DispatchGroup()
            let lock = NSLock()
            var active = false
            for id in ids {
                group.enter()
                let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
                self.fetchJSON(path: "/api/projects/\(escaped)/agents", at: baseURL) { (agents: Result<[[String: JSONValue]], Error>) in
                    defer { group.leave() }
                    guard case .success(let rows) = agents else {
                        lock.lock(); active = true; lock.unlock()
                        return
                    }
                    if rows.contains(where: { $0["session_status"]?.string == "running" }) {
                        lock.lock(); active = true; lock.unlock()
                    }
                }
            }
            group.notify(queue: .main) { completion(active) }
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
                    self.fetchStatus(at: record.url) { result in
                        switch result {
                        case .success(let status):
                            guard status.version == Self.supportedServerVersion else {
                                DispatchQueue.main.async {
                                    completion(.failure(BackendError.incompatibleVersion(status.version ?? "unknown")))
                                }
                                return
                            }
                            self.baseURL = record.url
                            self.status = status
                            self.bootstrapToken = record.bootstrapToken
                            DispatchQueue.main.async { completion(.success(status)) }
                        case .failure(let error):
                            DispatchQueue.main.async { completion(.failure(error)) }
                        }
                    }
                    return
                }
                if self.process?.isRunning == false { break }
                Thread.sleep(forTimeInterval: 0.05)
            }
            DispatchQueue.main.async { completion(.failure(BackendError.readinessTimedOut(logFile.path))) }
        }
    }

    private func fetchStatus(at baseURL: URL, completion: @escaping (Result<BackendStatus, Error>) -> Void) {
        fetchJSON(path: "/api/status", at: baseURL) { (result: Result<BackendStatus, Error>) in
            switch result {
            case .success(let status) where status.desktopProtocol != Self.supportedDesktopProtocol:
                completion(.failure(BackendError.incompatibleProtocol(status.desktopProtocol ?? 0)))
            default:
                completion(result)
            }
        }
    }

    private func fetchJSON<T: Decodable>(path: String, at baseURL: URL, completion: @escaping (Result<T, Error>) -> Void) {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            completion(.failure(BackendError.invalidResponse))
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                completion(.failure(error))
                return
            }
            guard let response = response as? HTTPURLResponse else {
                completion(.failure(BackendError.invalidResponse))
                return
            }
            guard response.statusCode == 200 else {
                completion(.failure(BackendError.serverRefused(response.statusCode)))
                return
            }
            guard let data else {
                completion(.failure(BackendError.invalidResponse))
                return
            }
            do {
                completion(.success(try JSONDecoder().decode(T.self, from: data)))
            } catch {
                completion(.failure(error))
            }
        }.resume()
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

private enum JSONValue: Decodable {
    case string(String)
    case bool(Bool)
    case number(Double)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }
}

extension Notification.Name {
    static let hydraBackendExited = Notification.Name("HydraBackendExited")
}
