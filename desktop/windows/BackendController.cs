using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace HydraDesktop;

internal sealed record BackendStatus(
    [property: JsonPropertyName("version")] string? Version,
    [property: JsonPropertyName("project_root")] string? ProjectRoot,
    [property: JsonPropertyName("default_project_id")] string? DefaultProjectId,
    [property: JsonPropertyName("desktop_protocol")] int? DesktopProtocol,
    [property: JsonPropertyName("build_id")] string? BuildId);

internal sealed record ReadyRecord(
    [property: JsonPropertyName("protocol")] int Protocol,
    [property: JsonPropertyName("url")] Uri Url,
    [property: JsonPropertyName("pid")] int Pid,
    [property: JsonPropertyName("bootstrap_token")] string BootstrapToken);

internal sealed record DesktopConnectRecord(
    [property: JsonPropertyName("protocol")] int Protocol,
    [property: JsonPropertyName("url")] Uri Url,
    [property: JsonPropertyName("bootstrap_token")] string BootstrapToken);

internal sealed class BackendController : IDisposable
{
    private const int SupportedDesktopProtocol = 2;
    private const string SupportedServerVersion = "0.1.0";
    private readonly HttpClient client = new() { Timeout = TimeSpan.FromSeconds(1.5) };
    private Process? process;
    private StreamWriter? log;
    private string? readyFile;

    internal Uri? BaseUrl { get; private set; }
    internal BackendStatus? Status { get; private set; }
    internal bool OwnsProcess => process is { HasExited: false };
    internal string? BootstrapToken { get; private set; }

    internal string? TakeBootstrapToken()
    {
        var token = BootstrapToken;
        BootstrapToken = null;
        return token;
    }

    internal async Task StartAsync(Func<string?> chooseProject)
    {
        var project = chooseProject();
        if (string.IsNullOrWhiteSpace(project))
        {
            throw new InvalidOperationException("No project was selected.");
        }
        if (!await ConnectThroughBundledCliAsync(project))
        {
            await LaunchBundledBackendAsync(project);
        }
    }

    private async Task<bool> ConnectThroughBundledCliAsync(string projectRoot)
    {
        var resources = Path.Combine(AppContext.BaseDirectory, "Resources");
        var binary = Environment.GetEnvironmentVariable("HYDRA_DESKTOP_BACKEND")
            ?? Path.Combine(resources, "HydraBackend.exe");
        if (!File.Exists(binary)) return false;
        var start = new ProcessStartInfo(binary)
        {
            WorkingDirectory = projectRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add("__desktop-connect");
        start.ArgumentList.Add("--project");
        start.ArgumentList.Add(projectRoot);
        AddBundledGit(start, resources);
        using var connector = Process.Start(start);
        if (connector is null) return false;
        var output = await connector.StandardOutput.ReadToEndAsync();
        await connector.WaitForExitAsync();
        if (connector.ExitCode != 0) return false;
        DesktopConnectRecord? record;
        try
        {
            record = System.Text.Json.JsonSerializer.Deserialize<DesktopConnectRecord>(output);
        }
        catch (System.Text.Json.JsonException)
        {
            return false;
        }
        if (record is null || record.Protocol != SupportedDesktopProtocol ||
            !IPAddress.TryParse(record.Url.Host, out var address) || !IPAddress.IsLoopback(address)) return false;
        var status = await FetchStatusAsync(record.Url);
        EnsureVersion(status);
        BaseUrl = record.Url;
        Status = status;
        BootstrapToken = record.BootstrapToken;
        return true;
    }

    internal void StopOwnedBackend()
    {
        if (process is not { HasExited: false })
        {
            return;
        }
        process.Kill(entireProcessTree: true);
        process.WaitForExit(5000);
        process.Dispose();
        process = null;
        log?.Dispose();
        log = null;
        if (readyFile is not null)
        {
            File.Delete(readyFile);
        }
    }

    internal async Task<bool> HasActiveSessionsAsync()
    {
        if (BaseUrl is null)
        {
            return false;
        }
        try
        {
            var projects = await client.GetFromJsonAsync<List<ProjectRecord>>(new Uri(BaseUrl, "/api/projects")) ?? [];
            foreach (var project in projects)
            {
                var id = Uri.EscapeDataString(project.Id);
                var agents = await client.GetFromJsonAsync<List<AgentRecord>>(new Uri(BaseUrl, $"/api/projects/{id}/agents")) ?? [];
                if (agents.Any(agent => agent.SessionStatus == "running"))
                {
                    return true;
                }
            }
            return false;
        }
        catch
        {
            return true;
        }
    }

    private async Task LaunchBundledBackendAsync(string projectRoot)
    {
        var resources = Path.Combine(AppContext.BaseDirectory, "Resources");
        var binary = Environment.GetEnvironmentVariable("HYDRA_DESKTOP_BACKEND")
            ?? Path.Combine(resources, "HydraBackend.exe");
        if (!File.Exists(binary))
        {
            throw new FileNotFoundException("HydraBackend.exe is missing from the application directory.", binary);
        }

        var appData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Hydra");
        var runtime = Path.Combine(appData, "runtime");
        var logs = Path.Combine(appData, "logs");
        Directory.CreateDirectory(runtime);
        Directory.CreateDirectory(logs);
        readyFile = Path.Combine(runtime, $"ready-{Guid.NewGuid():N}.json");
        var logPath = Path.Combine(logs, "backend.log");
        log = new StreamWriter(new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.Read)) { AutoFlush = true };

        var start = new ProcessStartInfo(binary, "server")
        {
            WorkingDirectory = projectRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.Environment["HYDRA_API_ADDR"] = "127.0.0.1:0";
        start.Environment["HYDRA_DESKTOP_READY_FILE"] = readyFile;
        AddBundledGit(start, resources);

        process = new Process { StartInfo = start, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, eventArgs) => { if (eventArgs.Data is not null) log?.WriteLine(eventArgs.Data); };
        process.ErrorDataReceived += (_, eventArgs) => { if (eventArgs.Data is not null) log?.WriteLine(eventArgs.Data); };
        if (!process.Start())
        {
            throw new InvalidOperationException("The Hydra backend could not be launched.");
        }
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            if (process.HasExited)
            {
                break;
            }
            if (File.Exists(readyFile))
            {
                var record = await ReadReadyRecordAsync(readyFile);
                if (record.Protocol != SupportedDesktopProtocol)
                {
                    throw new InvalidOperationException($"The bundled backend uses unsupported desktop protocol {record.Protocol}.");
                }
                if (!IPAddress.TryParse(record.Url.Host, out var address) || !IPAddress.IsLoopback(address))
                {
                    throw new InvalidOperationException("The bundled backend advertised a non-loopback address.");
                }
                var status = await FetchStatusAsync(record.Url);
                EnsureVersion(status);
                BaseUrl = record.Url;
                Status = status;
                BootstrapToken = record.BootstrapToken;
                return;
            }
            await Task.Delay(50);
        }
        throw new TimeoutException($"The Hydra backend did not become ready. See {logPath}.");
    }

    private static void AddBundledGit(ProcessStartInfo start, string resources)
    {
        var gitRoot = Path.Combine(resources, "Git");
        start.Environment["PATH"] = string.Join(Path.PathSeparator,
            Path.Combine(gitRoot, "cmd"), Path.Combine(gitRoot, "bin"), start.Environment["PATH"]);
        start.Environment["HYDRA_BUNDLED_GIT"] = Path.Combine(gitRoot, "cmd", "git.exe");
    }

    private static async Task<ReadyRecord> ReadReadyRecordAsync(string path)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return await System.Text.Json.JsonSerializer.DeserializeAsync<ReadyRecord>(stream)
            ?? throw new InvalidDataException("The backend readiness record is invalid.");
    }

    private async Task<BackendStatus> FetchStatusAsync(Uri baseUrl)
    {
        using var response = await client.GetAsync(new Uri(baseUrl, "/api/status"));
        if (response.StatusCode != HttpStatusCode.OK)
        {
            throw new InvalidOperationException($"A server on Hydra's address refused the app (HTTP {(int)response.StatusCode}).");
        }
        return await response.Content.ReadFromJsonAsync<BackendStatus>()
            ?? throw new InvalidDataException("The Hydra backend returned an invalid status response.");
    }

    private static void EnsureVersion(BackendStatus status)
    {
        if (status.DesktopProtocol != SupportedDesktopProtocol)
        {
            throw new InvalidOperationException($"Hydra desktop protocol {status.DesktopProtocol ?? 0} is incompatible with this app.");
        }
        if (status.Version != SupportedServerVersion)
        {
            throw new InvalidOperationException($"Hydra server version {status.Version ?? "unknown"} is incompatible with this app.");
        }
    }

    public void Dispose()
    {
        StopOwnedBackend();
        client.Dispose();
    }

    private sealed record ProjectRecord([property: JsonPropertyName("id")] string Id);
    private sealed record AgentRecord([property: JsonPropertyName("session_status")] string? SessionStatus);
}
