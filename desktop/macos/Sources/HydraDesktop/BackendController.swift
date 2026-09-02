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

enum BackendError: LocalizedError {
    case bundledBinaryMissing
    case launchFailed(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .bundledBinaryMissing:
            return "HydraBackend is missing from the app bundle."
        case .launchFailed(let detail):
            return "The Hydra backend could not be launched: \(detail)"
        case .invalidResponse:
            return "The Hydra backend returned an invalid status response."
        }
    }
}

final class BackendController {
    static let supportedDesktopProtocol = 3

    private(set) var baseURL: URL?
    private(set) var status: BackendStatus?
    private var bootstrapToken: String?

    func takeBootstrapToken() -> String? {
        defer { bootstrapToken = nil }
        return bootstrapToken
    }

    func start(completion: @escaping (Result<BackendStatus, BackendError>) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.connectThroughBundledCLI(completion: completion)
        }
    }

    private func connectThroughBundledCLI(completion: @escaping (Result<BackendStatus, BackendError>) -> Void) {
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
        process.arguments = ["__desktop-connect"]
        process.standardOutput = output
        process.standardError = errors
        process.terminationHandler = { [weak self] task in
            guard let self else { return }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            if task.terminationStatus != 0 {
                let detail = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                let error = BackendError.launchFailed(detail.trimmingCharacters(in: .whitespacesAndNewlines))
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
}
