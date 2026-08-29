using Microsoft.Web.WebView2.Core;

namespace HydraDesktop;

internal static class Program
{
    [STAThread]
    private static async Task Main()
    {
        ApplicationConfiguration.Initialize();

        using var backend = new BackendController();
        try
        {
            await backend.StartAsync(ChooseInitialProject);
            var profile = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Hydra", "WebView2");
            Directory.CreateDirectory(profile);
            var webViewEnvironment = await CoreWebView2Environment.CreateAsync(userDataFolder: profile);
            Application.Run(new HydraApplicationContext(backend, webViewEnvironment));
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Hydra could not start", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static string? ChooseInitialProject()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Choose a project for Hydra. You can add and switch projects inside the app.",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = false,
        };
        return dialog.ShowDialog() == DialogResult.OK ? dialog.SelectedPath : null;
    }
}

internal sealed class HydraApplicationContext : ApplicationContext
{
    private readonly BackendController backend;
    private readonly CoreWebView2Environment webViewEnvironment;
    private readonly List<HydraForm> windows = [];
    private readonly NotifyIcon trayIcon;
    private bool exiting;

    internal HydraApplicationContext(BackendController backend, CoreWebView2Environment webViewEnvironment)
    {
        this.backend = backend;
        this.webViewEnvironment = webViewEnvironment;
        var trayMenu = new ContextMenuStrip();
        trayMenu.Items.Add("New Hydra window", null, (_, _) => OpenWindow(HydraWindowKind.Full));
        trayMenu.Items.Add("New focused chat", null, (_, _) => OpenWindow(HydraWindowKind.Focused));
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add("Exit", null, async (_, _) => await ExitAsync());
        trayIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "Hydra",
            ContextMenuStrip = trayMenu,
            Visible = true,
        };
        trayIcon.DoubleClick += (_, _) => OpenWindow(HydraWindowKind.Full);
        OpenWindow(HydraWindowKind.Full);
    }

    internal void OpenWindow(HydraWindowKind kind, string? projectId = null)
    {
        var window = new HydraForm(kind, backend, webViewEnvironment, this, projectId);
        windows.Add(window);
        window.FormClosed += (_, _) => windows.Remove(window);
        window.Show();
    }

    internal void SetActiveProject(string projectId)
    {
        if (!string.IsNullOrWhiteSpace(projectId))
        {
            Application.UserAppDataRegistry.SetValue("LastProjectId", projectId);
        }
    }

    internal async Task ExitAsync()
    {
        if (exiting)
        {
            return;
        }
        if (backend.OwnsProcess && await backend.HasActiveSessionsAsync())
        {
            var answer = MessageBox.Show(
                "Quitting stops the app-owned backend and every running agent. Close the windows instead to leave work running in the background.",
                "Quit Hydra while agents are running?",
                MessageBoxButtons.OKCancel,
                MessageBoxIcon.Warning);
            if (answer != DialogResult.OK)
            {
                return;
            }
        }

        exiting = true;
        backend.StopOwnedBackend();
        foreach (var window in windows.ToArray())
        {
            window.AllowClose();
            window.Close();
        }
        trayIcon.Visible = false;
        trayIcon.Dispose();
        ExitThread();
    }
}
